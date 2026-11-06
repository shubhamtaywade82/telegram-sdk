/**
 * LIVE tests against Telegram DC2 - require real network access to
 * Telegram. Run with: MTPROTO_LIVE=1 npm run test:live
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importing the package root registers the TL schema (core + full layer);
// the handshake's tl()/tlMethod() calls fail without it.
import '../src/index.js';
import { TelegramClient } from '../src/client/telegram-client.js';
import { TelegramRpcError } from '../src/rpc.js';

const live = process.env.MTPROTO_LIVE === '1';

test('live auth-key handshake with Telegram DC2 (149.154.167.51:443)', { skip: !live }, async () => {
  const { MTProtoConnection } = await import('../src/mtproto/connection.js');
  const { MTProtoSession } = await import('../src/mtproto/session.js');
  const { createAuthKey } = await import('../src/mtproto/auth-key.js');
  const { TELEGRAM_RSA_KEYS } = await import('../src/crypto/rsa-keys.js');

  const conn = new MTProtoConnection({ host: '149.154.167.51', port: 443, dcId: 2, transport: 'intermediate' });
  const session = new MTProtoSession();
  await conn.connect();
  const result = await createAuthKey(conn, session, TELEGRAM_RSA_KEYS, { rsaScheme: 'auto', timeoutMs: 15000 });
  conn.close();

  assert.equal(result.authKey.length, 256);
  assert.notEqual(result.serverSalt, 0n);
  assert.ok(session.timeOffset !== undefined);
  console.log('live handshake OK: auth_key_id =', session.authKeyId.toString(), 'salt =', result.serverSalt.toString());
});

test('live encrypted RPC round-trip (updates.getState through the full client)', { skip: !live }, async () => {
  // Full client path: handshake -> invokeWithLayer(initConnection(updates.getState)).
  // Without a login the server answers AUTH_KEY_UNREGISTERED - which still
  // proves the whole encrypted request/response cycle end to end. A timeout
  // or a parse error means the cycle is broken and fails this test.
  const client = new TelegramClient({
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    dcId: 2,
    timeoutMs: 20000,
  });
  try {
    await client.connect();
    const result = (await client.invoke(
      (await import('../src/tl/index.js')).tlMethod('updates.getState', {}),
    )) as { name: string };
    assert.ok(result && typeof result.name === 'string', 'an authorized session must return a result object');
    console.log('live encrypted RPC OK (session was authorized):', result.name);
  } catch (err) {
    assert.ok(
      err instanceof TelegramRpcError,
      `expected an rpc_result (even an error one), got: ${err instanceof Error ? err.message : err}`,
    );
    assert.match(
      err.telegramMessage,
      /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_PASSWORD_NEEDED|USER_DEACTIVATED/,
      `unexpected rpc error: ${err.telegramMessage} (${err.code})`,
    );
    console.log('live encrypted RPC OK (rpc_error as expected pre-login):', err.telegramMessage);
  } finally {
    await client.disconnect();
  }
});
