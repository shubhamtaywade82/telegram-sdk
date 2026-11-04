/**
 * Example 4 — raw protocol access: any TL method of Layer 232, dynamically.
 *
 *   npx tsx examples/raw-api.ts
 */
import { TelegramClient, tlMethod, TelegramRpcError, LAYER, tl, type TLObject } from '../src/index.js';

console.log(`schema layer: ${LAYER}`);

const client = new TelegramClient({
  apiId: Number(process.env.API_ID ?? 12345),
  apiHash: process.env.API_HASH ?? '0123456789abcdef0123456789abcdef',
});

try {
  await client.connect();
  console.log(`connected to a production DC (auth key established without login)`);

  // resolve a username with the raw API (any Layer 232 method works)
  const resolved = await client.invoke<TLObject>(
    tlMethod('contacts.resolveUsername', { username: 'durov' }),
  );
  const user = (resolved.args.User ?? resolved.args.user) as TLObject | undefined;
  console.log('resolved:', user?.name, user?.args.username, 'id', user?.args.id?.toString());

  // exercise error handling: this throws PHONE_NUMBER_INVALID
  try {
    await client.invoke(tlMethod('auth.sendCode', {
      phone_number: 'not-a-phone',
      api_id: 12345,
      api_hash: '0123456789abcdef0123456789abcdef',
      settings: tl('codeSettings', {}),
    }));
  } catch (err) {
    if (err instanceof TelegramRpcError) {
      console.log(`server rejected as expected: ${err.telegramMessage} (${err.code})`);
    } else {
      throw err;
    }
  }
} finally {
  await client.disconnect();
}
