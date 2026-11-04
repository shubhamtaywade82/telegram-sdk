/**
 * Example 1 — user login (SMS code + optional 2FA) and basic messaging.
 *
 * Prerequisites: api_id/api_hash from https://my.telegram.org/apps.
 *   API_ID=12345 API_HASH=... npx tsx examples/user-login.ts
 */
import * as readline from 'node:readline/promises';
import { TelegramClient, loginUser, saveSession, loadSession } from '../src/index.js';

const apiId = Number(process.env.API_ID ?? 12345);
const apiHash = process.env.API_HASH ?? '0123456789abcdef0123456789abcdef';
const SESSION_FILE = 'examples/session.json';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const client = new TelegramClient({
  apiId,
  apiHash,
  session: loadSession(SESSION_FILE) ?? undefined,
});

try {
  await client.connect();

  if (!client.me) {
    const me = await loginUser(client, {
      phone: async () => (await rl.question('Phone number: ')).trim(),
      code: async () => (await rl.question('Login code: ')).trim(),
      password: async () => (await rl.question('2FA password (if enabled): ')).trim(),
    });
    saveSession(client, SESSION_FILE);
    console.log(`logged in as ${me.args.first_name} (@${me.args.username}), session saved`);
  } else {
    console.log(`resumed session as ${client.me.args.first_name}`);
  }

  // last 10 messages of a channel + send one formatted message
  const history = await client.messaging.getHistory('@durov', { limit: 10 });
  for (const m of history) {
    const text = (m.args.message as string | undefined) ?? '(media)';
    console.log(`- ${text.slice(0, 80)}`);
  }
  await client.messaging.sendMessage('@durov', 'Hello from <b>mtproto-sdk</b>!');
} finally {
  rl.close();
  await client.disconnect();
}
