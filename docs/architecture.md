# Architecture

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
