# Typed Bot API client (HTTPS) and generator

This module is the official HTTPS Bot API (`https://api.telegram.org/bot<token>/<method>`), as
distinct from the MTProto-backed facade (`BotApi`). It is generated from a committed snapshot of
the documentation, so every Bot API method and object is typed and regenerating for a new
release is a single command sequence.

Snapshot: **Bot API 10.3 (August 24, 2026)**, 400 types, 185 methods.

## Usage

```ts
import { BotApiHttpClient, BotApiHttpError } from 'mtproto-sdk';

const bot = new BotApiHttpClient({ token: process.env.BOT_TOKEN! });

const me = await bot.getMe();                       // User
await bot.sendMessage({ chat_id: 42, text: 'hi' }); // Message

// Files: pass bytes or a Blob with a name. Strings are file_ids or URLs and go out as-is.
await bot.sendPhoto({
  chat_id: 42,
  photo: { data: new Uint8Array(bytes), filename: 'chart.png', contentType: 'image/png' },
  caption: 'Nightly report',
});

// Albums: files nested in arrays are attached automatically (attach://fileN).
await bot.sendMediaGroup({
  chat_id: 42,
  media: [
    { type: 'photo', media: { data: a, filename: 'a.jpg' } },
    { type: 'photo', media: existingFileId },
  ],
});

try {
  await bot.sendMessage({ chat_id: 42, text: 'x' });
} catch (err) {
  if (err instanceof BotApiHttpError && err.retryAfter === undefined) {
    // err.errorCode, err.description, err.migrateToChatId (group -> supergroup)
  }
}
```

Methods without parameters take no argument (`bot.getMe()`). Methods with required parameters
require them at compile time (`sendMessage` needs `chat_id` and `text`).

Methods not in the snapshot (a future release) are reachable through
`bot.callRaw<T>(method, params)`: parameters are sent as given and the result is untyped.

## Retry and idempotency

| Condition | Behaviour |
| --- | --- |
| HTTP 429 with `retry_after` | Sleep for `retry_after`, then retry. Fails if it exceeds `maxRetryAfterSeconds` (default 60 s). Safe for every method: Telegram states the request was not processed. |
| 5xx, non-JSON response, network failure, timeout | Retried with exponential backoff **only for read-only methods** (`get*`). |
| Same failures for send methods | **Not retried.** The message may already have been delivered when the client timed out. The caller decides whether to resend. |
| `ok: false` (4xx) | Not retried. Mapped to `BotApiHttpError` with `errorCode`, `description`, `retryAfter`, `migrateToChatId`. |

`getUpdates` long polls automatically get a request timeout longer than their poll window.

Errors never include the bot token: the request URL contains it, so the transport reports only the
failure class and the Telegram description. This is covered by tests that search serialised errors
for the token.

## Upload typing

The documentation types some media fields as plain `String` while also describing multipart upload
through `attach://`. Those fields (25 in 10.3, such as `InputMediaPhoto.media` and
`InputSticker.sticker`) are widened to `InputFile | string` by the generator. The widening is
counted and printed on every run, so a change in the set is visible in review.

## Regenerating for a new Bot API release

```sh
npm run fetch:botapi          # download https://core.telegram.org/bots/api and write schema/bot-api/bot-api-<v>.json
npm run generate:botapi       # regenerate src/botapi/generated/*
npm run check:botapi          # fails if the committed generated sources are stale (run in CI)
npm test
```

`fetch:botapi --from <file>` parses a saved copy instead of downloading. The snapshot records the
SHA-256 of the source HTML. The parser fails the run on any construct it cannot resolve (return
type, field type, union members) rather than guessing; fix the parser and rerun.

Generated files: `types.ts` (objects and unions), `methods.ts` (parameter interfaces and the
`BotApiMethodMap`), `client.ts` (one method per Bot API method). Generation is deterministic.

## Known limits

- `Integer` maps to `number`. Telegram documents that some identifiers exceed 32 bits; they fit in
  JavaScript's safe integer range today, but the type is a number, not a bigint.
- Files are supplied as bytes or `Blob`. Reading a path from disk is the caller's responsibility.
- The HTTPS API is verified against the live endpoint only with an invalid token (transport and
  error mapping). Successful calls need a real bot token, which is not part of this repository's
  tests.
