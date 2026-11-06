# MTProto implementation roadmap

> **Status (2026-11-06, v0.2.0):** The review follow-up landed: protocol-constant pinning,
> msg_id conformance, the documented full-transport framing, `current_algo` 2FA, Vector RPC
> results, transparent salt resends, reconnection and DC migration, atomic+user-preserving
> sessions, and 55 offline tests with independent mocks. This document is historical.

> **Status (2026-11-04):** The scope gate has been satisfied. Phases 0–4 are implemented and
> tested in this repository — TL runtime with the pinned Layer 232 schema, AES-IGE / RSA_PAD /
> DH / SRP crypto, transports and the auth-key handshake, RPC with sessions and persistence,
> and phone/SMS + 2FA SRP + bot-token login. Phase 5 is partially implemented (peer resolution,
> dialogs/history, send, chunked media, update polling via `updates.getDifference`); secret
> chats, calls and E2E features remain out of scope as planned. See `CHANGELOG.md` for the
> shipped feature set and `tests/` for the conformance suites (known-answer vectors plus
> simulated-server integration tests, and an opt-in live handshake with production DC2).

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
