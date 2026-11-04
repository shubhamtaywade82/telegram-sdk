# MTProto implementation options

## Recommendation

Do not implement MTProto cryptography, authorization, and client lifecycle from scratch as the default path. Keep this repository's Bot API client independent, and add a separate optional MTProto adapter only when a user-account API is an explicit requirement.

## Options

| Option | Fit | Trade-off |
| --- | --- | --- |
| teleproto | Best TypeScript-native candidate for an optional MTProto adapter | Third-party fork; independently verify schema compatibility, release quality, auth behavior, and persistence security |
| TDLib | Official Telegram client stack | Native C++ library or WASM/bridge deployment; more operational weight |
| Custom MTProto | Only if there is a concrete requirement existing clients cannot satisfy | Highest protocol, cryptographic, interoperability, and maintenance risk |
| GramJS `telegram` npm package | Do not choose for new work | npm package is deprecated and upstream repository archived |

## teleproto validation gate

The teleproto project describes itself as a TypeScript MTProto client and a GramJS-compatible maintained fork. Before adding it as a dependency:

1. Inspect the exact version source, license, release notes, generated TL schema, and test suite.
2. Compare generated constructors and methods with Telegram's official TL schema and pin both schema provenance and the chosen library version.
3. Run known-answer tests for TL encoding, auth-key exchange, MTProto 2.0 message-key derivation, AES-IGE, transport framing, session/message IDs, and bad-message handling.
4. Test reconnect, DC migration, update difference recovery, 2FA/SRP, QR login, media transfers, and encrypted session persistence.
5. Ensure session strings and auth keys are handled as credentials: encrypt at rest, never log, and provide revocation/logout.

Version discrepancy to resolve: Telegram's public schema page currently displays Layer 225. teleproto's package versioning/documentation describes its 1.232.x release as layer 232. Do not assume that the numeric suffix matches the current public page; compare actual schema definitions and compatibility metadata.

## Boundary

Define an internal interface in this repository (for example, connect, authorize, invoke, subscribeUpdates, uploadFile, downloadFile, close). The adapter maps SDK-neutral types into the selected backend. Do not re-export the third-party library's complete type graph as the stable public contract.

## Decision

- Bot notifications and automation: use this repository's Bot API client.
- User-account/full Telegram client: prefer an optional teleproto adapter after the validation gate; choose TDLib if official-client parity is more important than a pure TypeScript deployment.
- Custom implementation: defer until a measurable requirement justifies owning the cryptographic and protocol surface.

## Update (2026-11-04)

The validation gate above was executed. Outcome: the clean-room, from-spec MTProto
implementation now lives in this repository (`src/`), and teleproto is used as a **reference
only** — for byte-level conformance of the server RSA keys, the DH safe-prime whitelist and
TL encodings (`scripts/extract-rsa-keys.mjs` re-verifies both) — never as a dependency. The
evaluation rationale is documented in the README ("Why this exists"). The Bot-API-compatible
surface is now a facade implemented over the MTProto core (`src/bot/bot-api.ts`) rather than
a separate HTTP client.
