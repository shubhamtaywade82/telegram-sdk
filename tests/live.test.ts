/**
 * LIVE handshake against Telegram DC2 - requires real network access to
 * Telegram. Run with: MTPROTO_LIVE=1 npm run test:live
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importing the package root registers the TL schema (core + full layer);
// the handshake's tl()/tlMethod() calls fail without it.
import '../src/index.js';

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
