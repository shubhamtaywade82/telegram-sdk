/**
 * Offline client/module unit tests: entity-cache-backed peer resolution
 * (no network, no mock server needed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../src/index.js';
import { TelegramClient } from '../src/client/telegram-client.js';

function offlineClient(): TelegramClient {
  // constructing a client does not connect anywhere
  return new TelegramClient({ apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef' });
}

test('cached chats resolve without an access hash (inputPeerChat needs only the id)', () => {
  const client = offlineClient();
  client.entityCache.update(sdk.tl('chat', { id: 42n, title: 'Test Chat' }));
  client.entityCache.update(sdk.tl('channel', { id: 100n, access_hash: 7n, title: 'Channel' }));
  client.entityCache.update(sdk.tl('user', { id: 9n, access_hash: 5n, username: 'alice' }));
  client.entityCache.update(sdk.tl('user', { id: 8n, username: 'bob' })); // no access hash

  // by numeric id (string) and by bigint: chats need no access hash
  const byString = client.messaging.toInputPeer('42');
  assert.equal(byString.name, 'inputPeerChat');
  assert.equal(byString.args.chat_id, 42n);
  const byBigint = client.messaging.toInputPeer(42n);
  assert.equal(byBigint.name, 'inputPeerChat');
  assert.equal(byBigint.args.chat_id, 42n);

  // users and channels still resolve when the hash is known
  const user = client.messaging.toInputPeer('9');
  assert.equal(user.name, 'inputPeerUser');
  assert.equal(user.args.access_hash, 5n);
  const channel = client.messaging.toInputPeer('100');
  assert.equal(channel.name, 'inputPeerChannel');
  assert.equal(channel.args.access_hash, 7n);

  // ...and still throw a helpful error when it is missing
  assert.throws(() => client.messaging.toInputPeer(8n), /access hash/);
  assert.throws(() => client.messaging.toInputPeer('8'), /not cached/);
});

test('resolvePeer returns cached chats/users synchronously without network', async () => {
  const client = offlineClient();
  client.entityCache.update(sdk.tl('chat', { id: 42n, title: 'Test Chat' }));
  const peer = await client.messaging.resolvePeer(42n);
  assert.equal(peer.name, 'inputPeerChat');
  assert.equal(peer.args.chat_id, 42n);

  // cache miss on a numeric id stays offline (no network lookup for ids)
  await assert.rejects(() => client.messaging.resolvePeer(12345n), /not cached/);
  // syntactically invalid usernames are rejected before any network call
  await assert.rejects(() => client.messaging.resolvePeer('@1invalid'), /cannot resolve/);
});

test("'me' resolves to inputPeerSelf", () => {
  const client = offlineClient();
  const peer = client.messaging.toInputPeer('me');
  assert.equal(peer.name, 'inputPeerSelf');
});
