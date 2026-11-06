/**
 * Offline module tests: update dispatch shapes, Bot facade id round-trips,
 * formatting (escapes + entities), entity-cache hash preservation, and
 * session-file semantics. No network, no mock server.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdk from '../src/index.js';
import { TelegramClient } from '../src/client/telegram-client.js';
import { saveSession, loadSessionFile, exportSessionString } from '../src/client/session-store.js';
import { secureRandom } from '../src/utils.js';

function offlineClient(): TelegramClient {
  return new TelegramClient({ apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef' });
}

// ---------------------------------------------------------------------------
// updates dispatch (M5)
// ---------------------------------------------------------------------------

test('updates: containers are opened and their messages reach onMessage', () => {
  const client = offlineClient();
  const got: sdk.TLObject[] = [];
  client.updates.onMessage = (m) => got.push(m);

  const message = sdk.tl('message', {
    id: 77,
    peer_id: sdk.tl('peerUser', { user_id: 42n }),
    message: 'hello container',
    date: 1700000000,
  });
  client.updates.handleUpdate(
    sdk.tl('updates', {
      updates: [sdk.tl('updateNewMessage', { message, pts: 1, pts_count: 1 })],
      users: [sdk.tl('user', { id: 42n, access_hash: 7n, first_name: 'U' })],
      chats: [],
      date: 1700000000,
      seq: 1,
    }),
  );

  assert.equal(got.length, 1, 'the contained message must be dispatched');
  assert.equal(got[0]!.args.message, 'hello container');
  // the container's users warmed the cache
  const cached = client.entityCache.resolve('42');
  assert.ok(cached);
  assert.equal(cached.accessHash, 7n);
});

test('updates: updateShortMessage synthesizes a message for onMessage', () => {
  const client = offlineClient();
  const got: sdk.TLObject[] = [];
  client.updates.onMessage = (m) => got.push(m);
  client.updates.onUpdate = () => assert.fail('short messages must not go to onUpdate');

  client.updates.handleUpdate(
    sdk.tl('updateShortMessage', {
      id: 5,
      user_id: 99n,
      message: 'short one',
      pts: 2,
      pts_count: 1,
      date: 1700000001,
      out: false,
    }),
  );
  assert.equal(got.length, 1);
  const msg = got[0]!;
  assert.equal(msg.name, 'message');
  assert.equal(msg.args.message, 'short one');
  assert.equal((msg.args.peer_id as sdk.TLObject).name, 'peerUser');
  assert.equal((msg.args.peer_id as sdk.TLObject).args.user_id, 99n);

  // and the chat variant maps chat_id/from_id
  client.updates.handleUpdate(
    sdk.tl('updateShortChatMessage', {
      id: 6,
      from_id: 7n,
      chat_id: 8n,
      message: 'short chat',
      pts: 3,
      pts_count: 1,
      date: 1700000002,
      out: false,
    }),
  );
  const chatMsg = got[1]!;
  assert.equal((chatMsg.args.peer_id as sdk.TLObject).name, 'peerChat');
  assert.equal((chatMsg.args.peer_id as sdk.TLObject).args.chat_id, 8n);
  assert.equal((chatMsg.args.from_id as sdk.TLObject).args.user_id, 7n);
});

// ---------------------------------------------------------------------------
// entity cache (M17) + facade round-trip (C6)
// ---------------------------------------------------------------------------

test('entity cache: a reduced entity never erases a known-good access hash', () => {
  const client = offlineClient();
  client.entityCache.update(sdk.tl('user', { id: 5n, access_hash: 123n, username: 'alice' }));
  // later a reduced user object (no access hash, e.g. from userShort)
  client.entityCache.update(sdk.tl('user', { id: 5n, username: 'alice' }));
  const cached = client.entityCache.resolve('@alice');
  assert.ok(cached);
  assert.equal(cached.accessHash, 123n, 'the hash must survive the reduced update');
});

test('bot facade: chat ids round-trip back into sendMessage', () => {
  const client = offlineClient();
  // a user the cache knows (as a real server would deliver in the update)
  client.entityCache.update(sdk.tl('user', { id: 42n, access_hash: 7n, first_name: 'U' }));
  const bot = new sdk.BotApi(client);

  // simulate the pushed update stream
  client.updates.onMessage?.(
    sdk.tl('message', {
      id: 100,
      peer_id: sdk.tl('peerUser', { user_id: 42n }),
      message: 'hi bot',
      date: 1700000000,
    }),
  );
  const updates = bot.getUpdates();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.update_id, 100, 'update ids use Telegram message ids');
  const chatId = updates[0]!.message!.chat.id;
  assert.equal(chatId, '42', 'chat ids are plain numeric strings');

  // the canonical echo-bot flow: the id must resolve to an InputPeer
  const peer = client.messaging.toInputPeer(chatId);
  assert.equal(peer.name, 'inputPeerUser');
  assert.equal(peer.args.user_id, 42n);
  assert.equal(peer.args.access_hash, 7n);
});

// ---------------------------------------------------------------------------
// formatting (M15 + entities)
// ---------------------------------------------------------------------------

test('markdownv2: backslash escapes yield literal reserved characters', () => {
  const r = sdk.parseMarkdownV2(String.raw`a \* b \_ c \` d \| e \\ f`);
  assert.equal(r.text, 'a * b _ c ` d | e \\ f');
  assert.equal(r.entities.length, 0, 'escaped marks must not create entities');

  // escaped characters do not toggle surrounding formatting
  const bold = sdk.parseMarkdownV2('*x* \\*not bold\\*');
  assert.equal(bold.text, 'x *not bold*');
  assert.equal(bold.entities.length, 1);
  assert.equal(bold.entities[0]!.name, 'messageEntityBold');
  assert.equal(bold.entities[0]!.args.length, 1);
});

test('markdownv2: backslashes inside code are literal', () => {
  const r = sdk.parseMarkdownV2('```C:\\path\\*to```');
  assert.equal(r.text, 'C:\\path\\*to');
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0]!.name, 'messageEntityPre');
});

test('html: entities are decoded in text and attribute values', () => {
  const r = sdk.parseHtml('a &lt;b&gt; &amp; c <a href="https://x/?a=1&amp;b=2">link</a>');
  assert.equal(r.text, 'a <b> & c link');
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0]!.name, 'messageEntityTextUrl');
  assert.equal(r.entities[0]!.args.url, 'https://x/?a=1&b=2');
});

// ---------------------------------------------------------------------------
// session files (M10 + M14)
// ---------------------------------------------------------------------------

test('session files: atomic save, missing vs corrupt distinction, user persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtproto-sdk-session-'));
  try {
    const path = join(dir, 'session.json');
    const client = offlineClient();
    client.session.setAuthKey(secureRandom(256));
    client.session.serverSalt = 42n;
    client.me = sdk.tl('user', { id: 10n, access_hash: 99n, first_name: 'Mock', username: 'mockuser' });

    saveSession(client, path);

    const ok = loadSessionFile(path);
    assert.equal(ok.status, 'ok');
    if (ok.status === 'ok') {
      assert.ok(ok.data.user, 'the logged-in user must be persisted');
      const restored = new TelegramClient({
        apiId: 12345,
        apiHash: '0123456789abcdef0123456789abcdef',
        session: ok.data,
      });
      assert.equal(restored.me?.args.username, 'mockuser');
    }

    const missingPath = join(dir, 'missing.json');
    assert.equal(loadSessionFile(missingPath).status, 'missing');

    writeFileSync(join(dir, 'corrupt.json'), '{"version": 1, "authKey": "not-base64!!",');
    const corrupt = loadSessionFile(join(dir, 'corrupt.json'));
    assert.equal(corrupt.status, 'corrupt', 'a corrupt file must be reported as corrupt');

    // export string round-trip keeps the user too
    const str = exportSessionString(client);
    const restoredFromString = new TelegramClient({
      apiId: 12345,
      apiHash: '0123456789abcdef0123456789abcdef',
      session: str,
    });
    assert.equal(restoredFromString.me?.args.username, 'mockuser');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
