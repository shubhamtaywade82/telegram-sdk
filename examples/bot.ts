/**
 * Example 2 — bot login and the Bot-API-compatible facade.
 *
 *   API_ID=12345 API_HASH=... BOT_TOKEN=... npx tsx examples/bot.ts
 */
import { TelegramClient, loginBot, BotApi } from '../src/index.js';

const apiId = Number(process.env.API_ID ?? 12345);
const apiHash = process.env.API_HASH ?? '0123456789abcdef0123456789abcdef';
const token = process.env.BOT_TOKEN ?? '';
if (!token) {
  console.error('set BOT_TOKEN (from @BotFather)');
  process.exit(1);
}

const client = new TelegramClient({ apiId, apiHash });

try {
  await client.connect();
  await loginBot(client, token);

  // the facade mirrors the official Bot API shapes
  const bot = new BotApi(client);
  const me = bot.getMe();
  console.log(`bot @${me.username} is running`);

  // listen for messages and echo them back
  await bot.start();
  setInterval(() => {
    for (const update of bot.getUpdates()) {
      if (update.message?.text) {
        console.log(`[${update.message.chat.id}] ${update.message.text}`);
        void bot.sendMessage(update.message.chat.id, `echo: ${update.message.text}`);
      }
    }
  }, 500);
} catch (err) {
  console.error(err);
  await client.disconnect();
}
