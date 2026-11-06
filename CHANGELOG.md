# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-06

Follow-up to the end-to-end engineering review of 0.1.0: all six critical findings, the
priority-one robustness set, and the release-engineering backlog are applied.

### Fixed (critical, all would have failed against production servers)

- **C1** — `rpc_result`/`msg_container` constructor ids were wrong (`0xf35c6d0a`/`0x73f1f4dc`
  instead of `0xf35c6d01`/`0x73f1f8dc`); every encrypted RPC against a real server timed out.
  Now pinned by a test that reads the ids from `src/tl/core.tl` itself.
- **C2** — the msg_id generator sign-extended through int32 bitwise AND, emitting epoch-1970
  ids for ~half of fresh sessions. Fixed with an unsigned shift; the mock servers now reject
  invalid client msg_ids.
- **C3** — the `full` transport implemented a private framing (wrong length semantics, no TCP
  sequence number, CRC excluding the sequence field, and a `0xef` magic byte that reads as
  abridged). Rewritten to the documented framing; verified by an interop test against an
  independent encoder.
- **C4** — 2FA login read `new_algo` (the set-new-password KDF) instead of `current_algo`;
  every real 2FA login failed. The mock now models the real `account.password` field layout.
- **C5** — cached basic group chats could never be used as send targets (an access hash was
  demanded although `inputPeerChat` needs none).
- **C6** — Bot facade chat ids were prefixed strings (`user:123`) that the peer resolver
  rejects; the echo-bot flow always threw. Facade ids are now plain numeric ids that resolve
  through the entity cache, and the example no longer swallows rejections.

### Fixed (robustness)

- **M1** — method results are parsed through `parseResult` with the declared result type, so
  the 41 methods returning a top-level `Vector` work.
- **M2** — conditional `flags.N?Bool` fields accept an explicit `false` (reference semantics);
  only presence-only `flags.N?true` treats `false` as unset.
- **M3** — `writeBytes` rejects lengths ≥ 2^24 instead of silently truncating.
- **M4** — pq factorization rejects prime (hostile) inputs fast; Pollard rho has an iteration cap.
- **M5** — `updates`/`updatesCombined` containers are opened and `updateShort*Message` forms
  reach `onMessage`.
- **M6** — automatic reconnection with backoff; pending invokes fail promptly on transport
  loss instead of hanging; the socket error listener is persistent; `connect()` is idempotent.
- **M7** — `PHONE/NETWORK/USER_MIGRATE_X` handled during login (fresh handshake on the target DC).
- **M8** — the first post-connect call is wrapped in `invokeWithLayer(initConnection(...))`.
- **M9** — `bad_server_salt` adopts the rotated salt and transparently resends (bounded);
  `new_session_created` updates the session salt.
- **M10** — session files are written atomically (temp file + rename); `loadSessionFile`
  distinguishes missing from corrupt.
- **M13** — photo downloads select the largest downloadable size from `photo.sizes`.
- **M14** — the logged-in user is persisted in the session and restored (`client.me`), so
  resumed clients skip re-login.
- **M15** — MarkdownV2 backslash escapes.
- **M16** — concurrent `updates.start()` calls can no longer orphan an interval.
- **M17** — a reduced entity can no longer erase a known-good access hash.
- **M18** — frame-size caps on all transports and linear-time reassembly buffering.
- **M19** — the `silent` sendMessage option is implemented (it was documented but missing);
  the FLOOD_WAIT example now uses `startsWith`; session-secrecy warning added.

### Added

- `SECURITY.md`, `CONTRIBUTING.md`, `.editorconfig`, a manual npm **publish workflow** with
  provenance, and a manually-triggered **live conformance job** that also performs one real
  encrypted RPC round-trip (and fails loudly).
- `TelegramClientOptions.timeoutMs`, `appVersion`, `maxReconnects`; `client.connected`;
  `client.switchDc()`; `TelegramRpcError.migrateDc()`; `tloToJson`/`jsonToTlo`;
  `loadSessionFile`; `RPC_ERROR_ID`.
- Test suite grew from 26 to 55 offline tests (55 pass; live tests opt-in): core.tl id
  pinning, msg_id conformance in mocks, full-transport interop vector, zlib CRC differential
  (Node ≥ 20.15), pinned IGE/PH1-PH2 vectors, Vector RPC results, salt rotation with
  transparent resend, module dispatch/facade/formatting/session coverage.

### Changed

- Version 0.2.0; `prepublishOnly` runs the full test suite.
- tsconfig strictness: `isolatedModules`, `noUnusedLocals/Parameters`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`.
- `@types/node` pinned to the 18 line (matching the `engines` floor that caused the
  zlib.crc32 regression in 0.1.x); CI typechecks the examples; CI has least-privilege
  permissions and PR-run concurrency cancellation.
- LICENSE: complete MIT text with the correct holder (was truncated and mis-attributed).
- Encrypted-message padding is randomized (12..1024) instead of the deterministic minimum.
- `dh_gen_fail` restarts the handshake once; crypto intermediates are zeroized best-effort;
  gzip inflation is capped (output size and nesting); `applyParseMode` (dead export) removed.
- Codegen parses the layer from the `// LAYER NNN` header of `api.tl` and warns on skipped lines.

## [0.1.0] - 2026-11-04

Initial release.

- **TL runtime**: binary serializer/deserializer for the Type Language, generated from the
  official Layer 232 schema (`core.telegram.org/schema.json`), with a dynamic
  (schema-driven) fallback so any constructor or method in the layer can be used.
- **MTProto 2.0 core**: `abridged`, `intermediate` and `full` TCP transports, unencrypted
  and encrypted message packing, auth-key creation handshake (`req_pq_multi` through
  `set_client_DH_params`), session state (msg_id, seq, salt), and PFS-ready structure.
- **Crypto**: AES-256-IGE, Telegram `RSA_PAD`, pq factorization, known-good
  dh_prime/g validation, and the 2FA SRP password check (`PH1`/`PH2`, `inputCheckPasswordSRP`).
- **Authorization**: user login via SMS code + optional 2FA SRP password, bot token login
  (`auth.importBotAuthorization`), session save/restore (file or string).
- **Modules**: messaging (send/history/dialogs, peer resolution), media (chunked
  upload/download), updates (polling with `updates.getDifference`).
- **Formatting**: pluggable message formatting - built-in entity parser by default,
  automatically upgraded to `@nemesis-oss/tg-format` when installed (optional peer).
- **Bot facade**: a Bot-API-compatible surface (`getMe`, `sendMessage`, `sendPhoto`,
  `getUpdates`) implemented over the MTProto core.
- Tests (unit + vectors + simulated-server integration), TypeDoc API reference,
  GitHub Actions CI, runnable examples.
