# Examples

Runnable against a real account/bot. Set credentials first:

```bash
export API_ID=12345                      # https://my.telegram.org/apps
export API_HASH=0123456789abcdef0123456789abcdef
export BOT_TOKEN=...                     # only for bot.ts
```

| File | Shows |
| --- | --- |
| `user-login.ts` | SMS login (+2FA), session persistence, history, formatted send |
| `bot.ts` | bot-token login, `BotApi` facade, update loop |
| `media.ts` | photo upload/download, formatting bridge |
| `raw-api.ts` | any Layer 232 method via `client.invoke`, typed RPC errors |

Run with [tsx](https://tsx.is) (already a dev dependency):

```bash
npx tsx examples/user-login.ts
```

Note: some calls (e.g. messaging a stranger) require the account to have the
peer in its dialogs; replace `@durov` with your own channel or a chat you are
allowed to message.
