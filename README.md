# mtproto-sdk

[![CI](https://github.com/shubhamtaywade82/telegram-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamtaywade82/telegram-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A TypeScript SDK for [Telegram](https://core.telegram.org)'s **MTProto 2.0** client protocol —
the binary transport that Telegram's own apps speak — with a high-level client API and an
optional **Bot-API-compatible facade** on top.

Everything is implemented from the primary sources: the [TL schema](https://core.telegram.org/schema),
the [MTProto protocol documentation](https://core.telegram.org/mtproto) and the
[API documentation](https://core.telegram.org/api). No third-party Telegram library is used at
runtime; the only dependency is Node.js itself (≥ 18.17). The package is **ESM-only**
(`"type": "module"`, use Node's native ESM support).

```
┌────────────────────────────────────────────────────────────┐
│  BotApi facade (getMe / sendMessage / sendPhoto / updates) │
├────────────────────────────────────────────────────────────┤
│  Feature modules: messaging · media · updates · formatting │
├────────────────────────────────────────────────────────────┤
│  TelegramClient: login flows, sessions, entity cache, RPC  │
├────────────────────────────────────────────────────────────┤
│  MTProto core: transports · message packing · handshake    │
├────────────────────────────────────────────────────────────┤
│  Crypto: AES-IGE · RSA_PAD · DH · 2FA SRP · pq factorizing │
├────────────────────────────────────────────────────────────┤
│  TL runtime: binary reader/writer + full Layer 232 schema  │
└────────────────────────────────────────────────────────────┘
```

## Why this exists

The npm name `telegram-sdk` is taken by a Mini-Apps library and is not an MTProto client.
The established TS MTProto clients are either archived (GramJS) or maintained forks
([teleproto](https://github.com/teleproto/teleproto), used here as a *reference* for
byte-level conformance, never as a dependency). `mtproto-sdk` is a clean-room,
from-spec implementation: small, typed, and documented.

## Evaluation: why `contractful-ts` was **not** used

The author's [`contractful-ts`](https://github.com/shubhamtaywade82/contractful-ts) generates
typed HTTP/WebSocket clients and servers from OpenAPI/AsyncAPI contracts, layered on axios.
MTProto is a fundamentally different beast:

| Requirement | MTProto | contractful-ts model |
| --- | --- | --- |
| Transport | Raw **TCP** with binary framing (abridged/intermediate/full) | HTTP request/response + WS |
| Payload encoding | **TL serialization** (4-byte constructor IDs, boxed/bare types, `flags` conditionals, vectors, gzip) | JSON |
| Security | AES-256-**IGE** encrypted envelopes, `msg_key` derivation, 64-bit `msg_id` rules, server salts | TLS (transport-provided) |
| Contract shape | 500+ constructors, schema-coupled **Layer** version, per-layer constructor IDs | OpenAPI paths/operations |
| Handshake | req_pq → RSA_PAD → DH key exchange → SRP (2FA) | none (auth headers) |

None of contractful-ts' machinery (path templates, JSON codecs, axios) can express a single
MTProto frame, and its contract format cannot carry TL's Layer semantics. Using it would have
added dead weight without reuse. **Decision: build the SDK directly; document the evaluation
here.** The one place a contract-first idea *does* carry over — deriving code from a machine
readable schema — is implemented natively: `scripts/codegen.mjs` regenerates the TL
descriptor tables from the pinned official schema (`src/tl/api.tl`, `src/tl/core.tl`).

What *is* reused from the author's ecosystem: the formatting layer is pluggable and
auto-detects [`@nemesis-oss/tg-format`](https://www.npmjs.com/package/@nemesis-oss/tg-format)
(the library published from `telegram-format`) — see [Formatting](#formatting).

## Install

```bash
npm install mtproto-sdk
```

You need `api_id` / `api_hash` credentials from <https://my.telegram.org/apps>.

## Quick start — user account (SMS code + 2FA)

```ts
import { TelegramClient, loginUser } from 'mtproto-sdk';

const client = new TelegramClient({
  apiId: 12345,
  apiHash: '0123456789abcdef0123456789abcdef',
  dcId: 2, // optional; inferred from the session once logged in
});

await client.connect();

const me = await loginUser(client, {
  phone: async () => '+15551234567',            // prompted once
  code: async () => await askUser('SMS code'),  // prompted once
  password: async () => await askUser('2FA password'), // only if 2FA is enabled
});
console.log(`logged in as @${me.args.username}`);

const messages = await client.messaging.getHistory('@durov', { limit: 10 });
await client.messaging.sendMessage('@durov', 'Hello from <b>mtproto-sdk</b>!');

await client.disconnect();
```

The login flow runs `auth.sendCode` → `auth.signIn`, and when the account has 2FA enabled it
transparently switches to `account.getPassword` → SRP (`auth.checkPassword` with
`inputCheckPasswordSRP`). The SRP math follows the official
[SRP](https://core.telegram.org/api/srp) specification (SHA-512, PBKDF2 100k, ModPow) and is
verified in tests by an independent server-side implementation.

## Quick start — bot token

```ts
import { TelegramClient, loginBot } from 'mtproto-sdk';

const client = new TelegramClient({ apiId, apiHash });
await client.connect();
const me = await loginBot(client, '123456:ABC-BOT-TOKEN');
```

## Bot-API-compatible facade

If you like the official Bot API's surface but want a single MTProto connection (no separate
HTTPS polling service), wrap the client:

```ts
import { BotApi } from 'mtproto-sdk'; // apiId/apiHash from env in this snippet

// one-shot: connect + bot login + facade
const bot = await BotApi.fromToken(token, { apiId, apiHash });

bot.getMe();                          // -> { id, username, first_name, ... }
await bot.sendMessage('@durov', 'hi');
await bot.start();                    // long-poll updates via MTProto
for (const update of bot.getUpdates()) {
  if (update.message) console.log(update.message.chat.id, update.message.text);
}

// or wrap a client you already manage:
// const bot = new BotApi(existingClient);
```

## Features

### Messaging — `client.messaging`

- `sendMessage(peer, text, opts?)` — HTML or MarkdownV2 formatting, reply-to, silent flag,
  link-preview toggle
- `getHistory(peer, { limit?, offsetId? })` — newest-first message history
- `getDialogs(limit?)` — conversation list
- `resolvePeer('@username' | '123456789' | bigint)` — entity resolution with access-hash caching
  (peers seen in any response are usable as inputs later; basic group chats resolve by id alone)

### Media — `client.media`

- `uploadFile(bytes, name?)` — chunked upload (`upload.saveBigFilePart`) → `InputFile`
- `sendPhoto(peer, bytes, caption?)`
- `downloadPhoto(message)` / `downloadDocument(message)` — chunked download into memory
  (photo downloads pick the largest downloadable size automatically)

### Updates — `client.updates`

- `start(intervalMs?)` / `stop()` — polls `updates.getDifference` and feeds a handler
- `handleUpdate(obj)` — manual feed (the RPC layer pushes unsolicited objects here);
  `updates`/`updatesCombined` containers are opened and the `updateShort*Message` short
  forms are mapped to messages before dispatch

### Resilience

- **Automatic reconnect** with exponential backoff after an unexpected disconnect (the auth
  key is reused; pending invokes fail fast instead of hanging)
- **DC migration**: `PHONE_MIGRATE_X` / `NETWORK_MIGRATE_X` / `USER_MIGRATE_X` are handled
  transparently during login (fresh handshake on the target DC, then retry)
- **Salt rotations**: `bad_server_salt` adopts the new salt and transparently resends the
  affected request; `new_session_created` updates the session salt in place
- The first API call after connect is wrapped in
  `invokeWithLayer(initConnection(...))` so the server always learns the layer

### Formatting

Messages accept three parse modes: `'html'` (default), `'markdownv2'` and `'none'`.
The built-in parsers produce `messageEntity*` objects with **UTF-16 offsets** (what Telegram
expects).

**Pluggable**: install `@nemesis-oss/tg-format` and its formatted output is accepted
everywhere a string is — the SDK duck-types `{ text, entities }` results and converts
automatically, with UTF-16 ↔ UTF-8 offset handling done for you:

```ts
import { format } from '@nemesis-oss/tg-format'; // optional peer dependency
await client.messaging.sendMessage(peer, format('Hello {name}!').bold('name'));
```

### Sessions

- `saveSession(client, path)` / `loadSessionFile(path)` — JSON file (atomic writes; missing
  and corrupt files are distinguished)
- `exportSessionString(client)` — compact base64 string, pass back through the
  `session` constructor option to resume without re-login; the logged-in user is persisted
  and restored (`client.me` survives), so resumed clients skip the login flow

```ts
const client = new TelegramClient({ apiId, apiHash, session: savedString });
await client.connect(); // reuses the stored auth key
```

> **Security:** a session string or session file grants **full access to the account** —
> it contains the authorization key. Store it like a password; never commit it.

## Lower-level API

The full protocol stack is exported and usable directly:

```ts
import {
  // TL layer (full Layer 232 registered on import)
  tl, tlMethod, parseTLObject, serializeTLObject, parseResult, registry, LAYER,
  TLReader, TLWriter,
  // crypto
  ige256Encrypt, ige256Decrypt, rsaPad, factorizePQ, computeSrpCheck, checkDhParams,
  // MTProto
  createTransport, MTProtoConnection, MTProtoSession, createAuthKey,
  packEncryptedMessage, parseEncryptedMessage, PRODUCTION_DCS,
  // errors
  TelegramRpcError,
} from 'mtproto-sdk';

// any method of the layer, dynamically typed:
const result = await client.invoke(
  tlMethod('contacts.resolveUsername', { username: 'durov' }),
);

// typed error handling
try {
  await client.messaging.sendMessage(peer, 'hi');
} catch (err) {
  if (err instanceof TelegramRpcError && err.telegramMessage.startsWith('FLOOD_WAIT')) {
    await sleep((err.waitSeconds() ?? 1) * 1000);
  }
}
```

Transports: `'abridged' | 'intermediate' | 'full'` (default `intermediate`), selected via the
`transport` client option.

## Protocol notes

- **Bundled server keys**: the two Telegram public RSA keys in `src/crypto/rsa-keys.ts` are
  extracted byte-for-byte from the official client distributions (via the
  `scripts/extract-rsa-keys.mjs` tool) and their SHA-1 fingerprints are re-derived at test
  time; they are public keys, not secrets.
- **Auth-key handshake** (`createAuthKey`): `req_pq_multi` → pq factorization →
  `p_q_inner_data_dc` sealed with the current **RSA_PAD** scheme (`data_with_padding` reversed,
  SHA-256 digest, IGE with a derived temp key), with automatic fallback to the legacy
  SHA-1-based scheme; server `dh_prime` is validated against the known 2048-bit prime and
  safe-prime/generator rules before use. `dh_gen_fail` restarts the exchange once.
- **Encrypted envelopes** follow MTProto 2.0: `msg_key = SHA256(auth_key[88+x..120+x] +
  plaintext)[8..24]`, AES-256-IGE with the spec's `sha256_a/b` key schedule, `x = 0` client→server
  and `x = 8` server→client, with randomized 12..1024-byte padding.
- **msg_id** is `unixtime << 32 | fraction`, divisible by 4, strictly monotonic; server time
  offset is learned during the handshake. Content messages get odd `seq_no`.
- **Server salt rotations** are tracked automatically: `new_session_created` updates the session
  salt in place, and `bad_server_salt` adopts the new salt and transparently resends the
  affected request.
- The `full` transport implements the documented framing — length counting the whole packet
  (itself + sequence + payload + CRC), a per-connection TCP sequence number starting at 0,
  CRC-32 over length+seq+payload, and **no magic bytes** — verified by an interop test against
  an independent encoder.
- The **live conformance job** (manual, from the Actions tab) performs a real key exchange with
  Telegram DC2 **plus one encrypted RPC round-trip** through the whole client stack, and fails
  loudly on error.

## Development

```bash
npm install
npm run codegen     # regenerate src/tl schema tables from the pinned TL schemas
npm run typecheck   # strict TS across src + tests (noUncheckedIndexedAccess & friends)
npm test            # build + unit/vector/mock-server tests (offline)
MTPROTO_LIVE=1 npm run test:live   # + real handshake & encrypted RPC with Telegram DC2
npm run docs        # TypeDoc API reference -> docs/api
```

The CI matrix runs Node 18/20/22/24 on every push, typechecks the examples, and builds the
docs. The live production-DC job is manual-only (Actions → CI → Run workflow) so it never
silently masks failures.

### Test coverage

| Area | What is verified |
| --- | --- |
| AES-IGE | round-trip, garble propagation, pinned vector, IV-half-swap rejection |
| RSA_PAD | structural verification with a local keypair + the real server key; modulus-size guards |
| pq factorization | known semiprimes; prime (hostile) inputs rejected fast; DH params: published prime, bad-value rejection |
| 2FA SRP | client M1 accepted by an independent server-side implementation; pinned PH1/PH2 derivation |
| TL runtime | flags round-trips (incl. conditional-Bool semantics), vectors, nested entities, gzip transparency, error cases, JSON (de)serialization |
| Transports | abridged (incl. 0x7f escape + split chunks), intermediate, full (documented framing + interop vector + CRC tamper + IEEE check value + zlib differential on new Node) |
| Messages | unencrypted/encrypted packing, x=0/x=8 key schedules, seq_no progression, randomized padding |
| RPC | rpc_result/containers, Vector results via `parseResult`, `bad_server_salt` salt rotation + transparent resend, core.tl id pinning |
| Handshake | full mock-server exchange (mock validates client msg_id), new+legacy RSA, unknown-fingerprint failure |
| Login | end-to-end encrypted RPC login incl. 2FA against a mock server; session round-trip incl. the logged-in user |
| Modules | peer resolution (chats without access hash, hash preservation), update dispatch (containers + short forms), facade id round-trips, formatting (escapes + entities), session files (atomic, corrupt vs missing) |
| Live | real auth-key handshake + encrypted RPC with production DC2 (manual job) |

### Project layout

```
src/
  tl/         TL runtime + generated Layer 232 schema (schema-all.ts) + core MTProto schema
  crypto/     AES-IGE, RSA (+ bundled server keys), DH validation, SRP, pq math
  mtproto/    transports, connection, message packing, auth-key handshake, session state
  client/     TelegramClient, login flows, session persistence
  modules/    messaging, media, updates, formatting
  bot/        Bot-API-compatible facade
tests/        unit, vectors, mock servers, live handshake
scripts/      codegen + RSA key extraction from the official docs
```

## License

MIT
