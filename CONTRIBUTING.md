# Contributing

Thanks for considering a contribution to `mtproto-sdk`!

## Development setup

```bash
git clone https://github.com/shubhamtaywade82/telegram-sdk.git
cd telegram-sdk
npm install
```

Requirements: Node.js >= 18.17 (the CI matrix runs 18/20/22/24).

## Everyday commands

```bash
npm run typecheck   # strict TS (noUncheckedIndexedAccess & friends)
npm test            # build + full offline suite (unit, vectors, mock servers)
npm run test:live   # opt-in: real handshake + encrypted RPC with Telegram DC2
npm run codegen     # regenerate src/tl/schema-*.ts from the pinned .tl files
npm run docs        # TypeDoc API reference -> docs/api
```

## Ground rules

1. **Protocol changes must be spec-sourced.** Every wire-format change cites
   the corresponding page of core.telegram.org (or the pinned
   `src/tl/*.tl` schema) in the PR description.
2. **Mocks must not import the code under test's constants.** The test
   servers declare protocol constants independently (see
   `tests/core-protocol.test.ts` for the pinning pattern) and validate
   client invariants (msg_id, session ids) so a client-side regression
   cannot silently change both sides of the conversation.
3. **Keep the suite offline-green.** The full offline suite must pass on
   Node 18, 20, 22 and 24 before merge; live tests stay opt-in.
4. **Regenerate, never hand-edit** `src/tl/schema-all.ts` /
   `schema-core.ts` — run `npm run codegen` and commit the result.
5. **No runtime dependencies.** The package depends on Node.js only;
   `@nemesis-oss/tg-format` stays an optional peer.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`),
like the existing history.
