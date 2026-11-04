# MTProto implementation roadmap

## Scope gate

The v0.1.0 package is not a full MTProto client. Do not expose TelegramClient until encrypted RPC, auth, updates and persistence pass independent conformance tests.

## Phase 0 — schema authority

- Pin official TL layer, source URL, retrieval timestamp and SHA-256 of the schema.
- Complete the TL grammar parser: namespaces, generic params, flags, conditional fields, vectors, bare/boxed types and combinators.
- Generate TypeScript types, constructor IDs, serializers, deserializers and method descriptors.
- Add deterministic regeneration, schema-diff CI and duplicate-ID rejection.

## Phase 1 — TL codec conformance

- Add all scalar, vector, object, flags-aware and generic encoders/decoders.
- Test known Telegram vectors and byte encodings.
- Bound allocations; reject malformed lengths, unknown constructors, invalid UTF-8 and truncated buffers.
- Differential-test against TDLib or another established implementation.

## Phase 2 — encrypted transport

- Implement one explicitly supported transport framing first.
- Implement authorization-key creation and MTProto 2.0 message-key derivation/encryption exactly as specified.
- Implement containers, session IDs, salts, time offsets, message IDs, sequence numbers, acknowledgements and bad-message recovery.
- Fuzz frame parsers and require cryptographic test vectors plus independent security review before real credentials.

## Phase 3 — RPC and sessions

- Correlate RPC requests/results and server errors.
- Handle service messages, invokeWithLayer, initConnection, gzip-packed objects and layer negotiation.
- Add DC discovery/migration, reconnect and authorization-key persistence.

## Phase 4 — user authorization

- Implement phone/code authorization, delivery variants, QR login and SRP-based 2FA.
- Use an injected secure-storage interface for auth keys and session data.
- Add logout, session invalidation, credential rotation and redacted diagnostics.

## Phase 5 — updates and usable API

- Implement pts/qts/seq/date state, gap detection, difference recovery and durable state.
- Add peers, pagination, dialogs/history, send/edit/delete, media and DC-aware file transfer.
- Treat secret chats, calls and E2E features as separately reviewed projects.

## Alternative

Evaluate TDLib as a native runtime backend before implementing a full pure-TypeScript MTProto stack. A TypeScript façade over TDLib may be safer and more complete sooner.
