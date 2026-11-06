# Independent-implementation oracles

`tests/oracle-teleproto.test.ts` checks this SDK's protocol primitives against separately
maintained libraries. The inputs are fixed, the tests use no network, and each comparison has a
negative control so a passing run means the comparison was able to fail.

| Check | Oracle | Result |
| --- | --- | --- |
| LAYER constant | teleproto 1.232.1 (`LAYER = 232`) | equal |
| TL serialisation: `help.getConfig`, `messages.getHistory` (int, long, peer union), `auth.sendCode` (strings, nested flags) | teleproto `Api` classes | byte-identical |
| TL serialisation: `codeSettings` with flag bits | teleproto | byte-identical |
| Connection init wrapper `invokeWithLayer(232, initConnection(help.getConfig))` | teleproto `InvokeWithLayer(InitConnection)` | byte-identical |
| AES-256-IGE encrypt, 16 to 1024 bytes | cifrante 0.8.1 `aes.ige` | byte-identical; SDK decrypts the independent ciphertext |

Negative controls: a deliberately different `flags` value, a different IV, and a missing field
each compare unequal, which confirms the comparisons can fail.

## Not cross-checked

These are covered by unit tests against published vectors, but no independent implementation is
reachable through a public API, so no oracle comparison is made:

- RSA_PAD and the server key table: teleproto keeps its key map unexported.
- pq factorisation and DH parameter validation: teleproto's `Factorizator` and DH checks are unexported.
- SRP (2FA): teleproto exposes `computeCheck`, but it draws its random `a` internally, so outputs
  cannot be compared deterministically.

## Finding: generic TL wrappers are not registered

`scripts/codegen.mjs` skips declarations with generic parameters (`{X:Type}`). That excludes
`initConnection` and `invokeWithLayer` from the schema registry, so `TLRegistry` cannot serialise
them by name. The client hand-serialises the connection wrapper (`wrapWithInitConnection`), and the
oracle above confirms those bytes match teleproto. Any other generic wrapper the client needs would
hit the same gap.

## Live verification

The live handshake tests (`MTPROTO_LIVE=1`) need outbound MTProto to Telegram DCs. In the sandbox
where these tests were developed, DC 149.154.167.50/51 accepted TCP on ports 80 and 443 but returned
no bytes, and port 5222 refused connections, so the live path was not verified there.
