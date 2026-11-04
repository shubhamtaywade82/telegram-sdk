/**
 * Example 3 — media upload/download and pluggable formatting.
 *
 *   API_ID=12345 API_HASH=... npx tsx examples/media.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { TelegramClient, loginUser, saveSession, loadSession } from '../src/index.js';

const apiId = Number(process.env.API_ID ?? 12345);
const apiHash = process.env.API_HASH ?? '0123456789abcdef0123456789abcdef';
const SESSION_FILE = 'examples/session.json';

const client = new TelegramClient({
  apiId,
  apiHash,
  session: loadSession(SESSION_FILE) ?? undefined,
});

try {
  await client.connect();
  if (!client.me) {
    await loginUser(client, {
      phone: async () => (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }).question('Phone: '),
      code: async () => '00000', // replace with a real prompt in production code
      password: async () => '',
    });
    saveSession(client, SESSION_FILE);
  }

  // chunked upload + photo send (put a real JPEG next to this example first)
  try {
    const bytes = new Uint8Array(readFileSync('examples/photo.jpg'));
    await client.media.sendPhoto('@durov', { data: bytes, name: 'photo.jpg' }, 'sent via <b>mtproto-sdk</b>');
    console.log('photo sent');
  } catch {
    console.log('(skip examples/photo.jpg — not found)');
  }

  // download the photo from the newest message of a chat and save it
  const history = await client.messaging.getHistory('@durov', { limit: 1 });
  if (history[0]) {
    try {
      const photo = await client.media.downloadPhoto(history[0]);
      writeFileSync('examples/downloaded.jpg', photo);
      console.log(`downloaded ${photo.length} bytes`);
    } catch (err) {
      console.log(`(newest message has no photo: ${err instanceof Error ? err.message : err})`);
    }
  }

  // formatted text: { text, entities } objects from @nemesis-oss/tg-format are
  // accepted directly when the package is installed (optional peer dependency):
  //
  //   import { format } from '@nemesis-oss/tg-format';
  //   await client.messaging.sendMessage(peer, format('Hello!').bold());
} finally {
  await client.disconnect();
}
