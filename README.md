# @nemesis-oss/telegram-sdk

A TypeScript Telegram SDK with a practical **Bot API client** and a separately scoped **MTProto/TL foundation**.

> Scope is explicit: the Bot API client is implemented. The MTProto folder currently provides TL serialization primitives and a basic schema declaration parser; it is not yet a full MTProto client and must not be used for user-account authentication or production MTProto traffic.

## Protocols

Telegram exposes different developer interfaces:

| Interface | Intended use | SDK scope |
| --- | --- | --- |
| Bot API | Bot accounts, HTTPS requests, webhooks, long polling | Implemented foundation |
| Telegram API / MTProto | Full Telegram clients and user-account sessions | Protocol groundwork only |
| TDLib | Telegram's cross-platform client library | Future optional adapter |
| Gateway API | Deliver verification codes | Not in scope |

The Bot API hides MTProto and exposes HTTPS. A full Telegram user client requires TL schema/type serialization, MTProto 2.0 encryption and authorization, transport framing, session/message sequencing, data-center migration, user login, and update synchronization. These protocols are not interchangeable.

## Install

```bash
npm install @nemesis-oss/telegram-sdk
```

Node.js 20.3+; standard Fetch, Blob, FormData and AbortSignal APIs; zero runtime dependencies.

## Bot API quick start

```ts
import { TelegramBotApiClient } from '@nemesis-oss/telegram-sdk';

const telegram = new TelegramBotApiClient({
  token: process.env.TELEGRAM_BOT_TOKEN!,
});

const me = await telegram.getMe();
console.log(`Connected as @${me.username ?? me.first_name}`);

await telegram.sendMessage({
  chat_id: process.env.TELEGRAM_CHAT_ID!,
  text: 'Deployment completed',
});
```

### Use telegram-format without a hard dependency

`sendMessage` accepts a plain string or a structural `{ text, entities }` value. It does not import or depend on `@nemesis-oss/tg-format`.

```ts
import { TelegramBotApiClient } from '@nemesis-oss/telegram-sdk';
import { fmt, bold, code, link } from '@nemesis-oss/tg-format';

const telegram = new TelegramBotApiClient({ token: process.env.TELEGRAM_BOT_TOKEN! });
const formatted = fmt`Build ${bold('passed')}. Run ${code('npm test')} or ${link('open CI', 'https://example.com/ci')}.`;

// Preferred: native entities, no parse_mode and no markup escaping.
await telegram.sendMessage({ chat_id: 123456789, text: formatted });

// Alternative: HTML renderer.
await telegram.sendMessage({
  chat_id: 123456789,
  text: formatted.toHTML(),
  parse_mode: 'HTML',
});
```

The formatter integration is structural: any library returning `text` plus Telegram-compatible `entities` can be used. Formatting and transport stay independently versioned.

### Generic API methods

Typed convenience methods cover common operations. `call<T>` is the escape hatch for every other current and future Bot API method.

```ts
const chat = await telegram.call<{ id: number; type: string }>('getChat', {
  chat_id: '@channel_name',
});

await telegram.call<boolean>('pinChatMessage', {
  chat_id: chat.id,
  message_id: 123,
});
```

The generic method's return type is caller-selected; it does not perform runtime response-schema validation.

### Files

```ts
await telegram.sendDocument({
  chat_id: 123456789,
  document: {
    data: new Blob(['report contents'], { type: 'text/plain' }),
    fileName: 'report.txt',
  },
  caption: 'Daily report',
});

const file = await telegram.getFile('telegram-file-id');
if (file.file_path) {
  const bytes = await telegram.downloadFile(file.file_path);
  // Persist bytes using your application's storage layer.
}
```

File uploads use `FormData`; do not manually set multipart `Content-Type`, because Fetch supplies the boundary. File-id and URL strings are passed through as Bot API references.

### Long polling

```ts
const controller = new AbortController();

await telegram.pollUpdates(async (update) => {
  if (update.message?.text === '/start') {
    await telegram.sendMessage({
      chat_id: update.message.chat.id,
      text: 'Welcome.',
    });
  }
}, { signal: controller.signal, timeout: 30 });

// Later: controller.abort();
```

Updates are acknowledged by advancing the offset only after the handler completes. If a handler throws, the loop exits without advancing past that update. Persist offsets externally for restart-safe processing. One long-poll loop is allowed per client instance.

## v0.1.0 surface

- Bot API: `call`, `getMe`, `sendMessage`, `editMessageText`, `deleteMessage`, `getUpdates`.
- Files: `sendDocument`, `sendPhoto`, `getFile`, `downloadFile`.
- Long polling with abort support and handler-before-offset acknowledgement.
- Injectable Fetch, timeout, HTTPS base URL validation, sanitized error messages.
- Telegram API errors expose error code, HTTP status, `retry_after`, and `migrate_to_chat_id`.
- TL groundwork: int/long/double/bool/bytes/string/vector reader/writer and a basic explicit-ID declaration parser.

The Bot API methods and object types are intentionally a subset. Generic `call<T>` supports the full method namespace but is not a substitute for generated method/response types. The next Bot API milestone is automatic type generation from Telegram's official machine-readable Bot API documentation. Telegram's documentation currently identifies Bot API 10.3 (August 24, 2026); this package does not claim complete 10.3 type coverage.

## Contractful decision

`contractful-ts` is **not a runtime dependency**.

It has useful generic infrastructure for typed HTTP contracts, validation, auth providers, retries, circuit breakers, rate limiting and WebSocket events. However:

- Telegram publishes a Bot API document, not an official OpenAPI contract that contractful-ts directly consumes.
- The existing Axios runtime does not natively model Bot API multipart `InputFile` uploads and result/error envelope semantics.
- MTProto is binary RPC plus cryptographic authorization, transport and session state. `defineApi` and the JSON-oriented events runtime are not substitutes.
- Adding contractful-ts would add another abstraction around an API that is straightforward to call with Fetch and would blur the MTProto boundary.

A future optional integration could add a Bot API specification adapter to contractful-ts after it can express uploads, response envelopes, method-specific rate limits and retry safety. Do not put TL serialization or MTProto encryption inside contractful-ts.

## MTProto status and roadmap

The `./mtproto/tl` export is only a starting point for binary schema work.

Implemented groundwork:
- Little-endian TL int, uint, long, double and Bool constructors.
- TL bytes/string with short/extended length prefixes and four-byte padding.
- TL vectors.
- Basic line-oriented explicit-ID constructor and RPC declaration parsing.

Not implemented:
- Full TL grammar, generated types, generic combinators, flags-aware serializers and complete response decoders.
- MTProto 2.0 authorization-key exchange, message-key derivation, AES-IGE crypto, transport obfuscation and framing.
- Session/message-ID and sequence-number management, acknowledgements, containers, salt/time synchronization and bad-message recovery.
- DC discovery/migration, user login, QR authorization, 2FA/SRP, persistence, update difference state, file transfer, secret chats or calls.

Do not send MTProto packets with the TL primitives alone. A correct client needs every protocol layer and security review. Evaluate TDLib as an alternative backend before committing to a full pure-TypeScript MTProto client.

## Development

```bash
npm install
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

Tests use injected Fetch implementations; no real bot token or network access is needed.

## Sources

- [Telegram APIs overview](https://core.telegram.org/api)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [MTProto](https://core.telegram.org/mtproto)
- [Current TL schema](https://core.telegram.org/schema)
- [telegram-format](https://github.com/shubhamtaywade82/telegram-format)
- [contractful-ts](https://github.com/shubhamtaywade82/contractful-ts)

## License

MIT
