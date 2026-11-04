import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBotApiClient, TelegramApiError } from '../dist/index.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('getMe unwraps Bot API result', async () => {
  const client = new TelegramBotApiClient({
    token: '123:secret',
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://api.telegram.org/bot123:secret/getMe');
      assert.equal(init.method, 'POST');
      return json({ ok: true, result: { id: 7, is_bot: true, first_name: 'Bot' } });
    },
  });
  assert.deepEqual(await client.getMe(), { id: 7, is_bot: true, first_name: 'Bot' });
});

test('sendMessage accepts {text, entities} without parse_mode', async () => {
  let sent;
  const client = new TelegramBotApiClient({
    token: '123:secret',
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return json({ ok: true, result: { message_id: 1, chat: { id: 2, type: 'private' }, date: 1, text: 'hello' } });
    },
  });
  await client.sendMessage({ chat_id: 2, text: { text: 'hello', entities: [{ type: 'bold', offset: 0, length: 5 }] } });
  assert.equal(sent.text, 'hello');
  assert.deepEqual(sent.entities, [{ type: 'bold', offset: 0, length: 5 }]);
  assert.equal('parse_mode' in sent, false);
});

test('API errors preserve retry parameters and do not expose the token', async () => {
  const client = new TelegramBotApiClient({
    token: '123:super-secret',
    fetch: async () => json({
      ok: false, error_code: 429, description: 'Too Many Requests',
      parameters: { retry_after: 4 },
    }, 429),
  });
  await assert.rejects(client.getMe(), (error) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.errorCode, 429);
    assert.equal(error.retryAfter, 4);
    assert.equal(error.message.includes('super-secret'), false);
    return true;
  });
});

test('sendDocument uploads multipart and leaves boundary to Fetch', async () => {
  let body;
  let headers;
  const client = new TelegramBotApiClient({
    token: '123:secret',
    defaultHeaders: { 'content-type': 'application/json' },
    fetch: async (_url, init) => {
      body = init.body;
      headers = new Headers(init.headers);
      return json({ ok: true, result: true });
    },
  });
  await client.sendDocument({
    chat_id: 2,
    document: { data: new Blob(['hello']), fileName: 'hello.txt' },
    caption: 'report',
  });
  assert.ok(body instanceof FormData);
  assert.equal(body.get('chat_id'), '2');
  assert.equal(body.get('caption'), 'report');
  assert.equal(body.get('document').name, 'hello.txt');
  assert.equal(headers.has('content-type'), false);
});

test('getFile and downloadFile use the file endpoint', async () => {
  const urls = [];
  const client = new TelegramBotApiClient({
    token: '123:secret',
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url).includes('/getFile')) {
        return json({ ok: true, result: { file_id: 'f', file_unique_id: 'u', file_path: 'docs/a.txt' } });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  const file = await client.getFile('f');
  const bytes = await client.downloadFile(file.file_path);
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(urls[1], 'https://api.telegram.org/file/bot123:secret/docs/a.txt');
});

test('long polling advances offset only after handler succeeds', async () => {
  const offsets = [];
  let count = 0;
  const client = new TelegramBotApiClient({
    token: '123:secret',
    fetch: async (_url, init) => {
      offsets.push(JSON.parse(init.body).offset ?? null);
      count += 1;
      return json({ ok: true, result: count === 1 ? [{ update_id: 10 }] : [{ update_id: 11 }] });
    },
  });
  const controller = new AbortController();
  let handled = 0;
  await client.pollUpdates(async () => {
    handled += 1;
    if (handled === 2) controller.abort();
  }, { signal: controller.signal, timeout: 0 });
  assert.deepEqual(offsets, [null, 11]);
});

test('a failed update handler does not advance the polling offset', async () => {
  let calls = 0;
  const client = new TelegramBotApiClient({
    token: '123:secret',
    fetch: async () => { calls += 1; return json({ ok: true, result: [{ update_id: 20 }] }); },
  });
  await assert.rejects(client.pollUpdates(async () => { throw new Error('handler failed'); }, { timeout: 0 }));
  assert.equal(calls, 1);
});

test('rejects non-HTTPS remote API URLs and invalid method names', async () => {
  assert.throws(() => new TelegramBotApiClient({ token: '123:secret', apiBaseUrl: 'http://example.com' }), /HTTPS/);
  const client = new TelegramBotApiClient({ token: '123:secret', fetch: async () => json({ ok: true, result: true }) });
  await assert.rejects(client.call('../getMe'), /method name/);
});

test('network error cause redacts the bot token', async () => {
  const client = new TelegramBotApiClient({
    token: '123:very-secret',
    fetch: async () => { throw new Error('Failed https://api.telegram.org/bot123:very-secret/getMe'); },
  });
  await assert.rejects(client.getMe(), (error) => {
    assert.equal(error.message.includes('very-secret'), false);
    assert.equal(error.cause.message.includes('very-secret'), false);
    return true;
  });
});
