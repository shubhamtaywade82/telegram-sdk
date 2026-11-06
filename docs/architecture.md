# Architecture

> **Status (2026-11-06, v0.2.0):** All findings of the end-to-end engineering review are
> applied. The npm package is named **mtproto-sdk** (the repository keeps the name
> `telegram-sdk`); the package-boundary sketch below predates the implementation and is
> kept for history — see the "Update" section for what actually shipped.

## Design rules

1. Bot API and MTProto remain separate protocols.
2. Formatting stays independent from transport. Accept the structural { text, entities } value produced by telegram-format.
3. Keep bot tokens and MTProto authorization material out of error messages, logs and telemetry.
4. Do not automatically replay send operations after ambiguous network failures; Telegram may have accepted the message before the timeout.
5. Inject transport dependencies and make protocol behavior deterministic under tests.
6. Pin Telegram API/schema versions and hashes for generated artifacts.

## Package boundary

```text
telegram-sdk
├── bot-api/   Fetch transport, JSON envelope, multipart, file download, long polling
└── mtproto/   TL schema, codec, crypto, transport, session, auth, updates, files (roadmap)
```

## Bot API lifecycle

```text
typed wrapper or call<T>
  -> normalize formatted text into { text, entities }
  -> JSON or multipart FormData
  -> Fetch + AbortSignal
  -> parse Bot API { ok, result | error } envelope
  -> result or TelegramApiError
```

No retries are performed by default. A future retry layer must distinguish read/idempotent methods from writes and require an explicit policy for ambiguous failures.

## contractful-ts boundary

Do not use contractful-ts as the MTProto runtime. It is a generic HTTP/WebSocket contracts toolkit, not a TL serializer, crypto layer, transport framing implementation or MTProto session manager. The Bot API is currently smaller and more accurate with native Fetch because Bot API methods have multipart upload and JSON-envelope semantics. Revisit an optional adapter only when a Bot API spec adapter supports uploads, envelopes, method-specific rate limits and retry safety.

## telegram-format boundary

No formatter package dependency is required. The SDK accepts a structural FormattedText object. The formatter owns parsing/escaping and UTF-16 entity offsets; the SDK owns network serialization and Telegram API errors.

## Update (2026-11-04)

The implemented architecture supersedes the fetch-based Bot API boundary described above.
`src/` now contains the full MTProto 2.0 stack: TL runtime and generated Layer 232 schema
(`src/tl`), crypto (`src/crypto`), transports/handshake (`src/mtproto`), RPC and
`TelegramClient` with sessions (`src/rpc.ts`, `src/client`), feature modules
(`src/modules`) and a Bot-API-compatible facade over MTProto (`src/bot`). The design rules
above still apply (separate protocols at the facade level, formatting independent of
transport, no credential leakage, no automatic replays, injectable transports, pinned
schema artifacts); see the README for the current layer diagram and `CHANGELOG.md` for the
shipped feature set.
