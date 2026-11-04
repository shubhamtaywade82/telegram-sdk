# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
