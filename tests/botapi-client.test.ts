import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BotApiHttpClient, BotApiHttpError, isInputFile } from '../src/index.js';

type Reply = { status: number; body: unknown } | { throws: Error };
interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

function harness(replies: Reply[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
      signal: init?.signal ?? undefined,
    });
    const next = replies.shift();
    if (!next) throw new Error('no scripted reply left');
    if ('throws' in next) throw next.throws;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetchImpl, sleep };
}

const TOKEN = '123456:SECRET-TOKEN-VALUE';
const ok = (result: unknown): Reply => ({ status: 200, body: { ok: true, result } });
const fail = (status: number, body: Record<string, unknown>): Reply => ({
  status,
  body: { ok: false, ...body },
});

test('builds the method URL with the token and sends JSON for plain parameters', async () => {
  const h = harness([ok({ id: 1, is_bot: true, first_name: 'Bot' })]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  const me = await client.getMe();
  assert.equal(me.id, 1);
  assert.equal(h.calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/getMe`);
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.headers['content-type'], 'application/json');
});

test('typed sendMessage serialises parameters and drops undefined fields', async () => {
  const h = harness([ok({ message_id: 9, date: 0, chat: { id: 7, type: 'private' } })]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  const msg = await client.sendMessage({ chat_id: 7, text: 'hi', parse_mode: 'MarkdownV2', disable_notification: undefined });
  assert.equal(msg.message_id, 9);
  assert.deepEqual(JSON.parse(String(h.calls[0]?.body)), { chat_id: 7, text: 'hi', parse_mode: 'MarkdownV2' });
});

test('a file parameter switches the request to multipart and names the part after the field', async () => {
  const h = harness([ok({ message_id: 2, date: 0, chat: { id: 5, type: 'private' } })]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  await client.sendPhoto({
    chat_id: '@channel',
    photo: { data: new Uint8Array([1, 2, 3]), filename: 'pic.png', contentType: 'image/png' },
    caption: 'hello',
  });
  const form = h.calls[0]?.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('chat_id'), '@channel');
  assert.equal(form.get('caption'), 'hello');
  assert.ok(form.get('photo') instanceof Blob, 'photo is sent as a file part');
  const wire = await new Response(form).text();
  assert.match(wire, /name="photo"; filename="pic.png"/);
  assert.match(wire, /Content-Type: image\/png/);
});

test('files nested in arrays are sent as attach:// references with separate parts', async () => {
  const h = harness([ok([{ message_id: 3, date: 0, chat: { id: 5, type: 'private' } }])]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  await client.sendMediaGroup({
    chat_id: 5,
    media: [
      { type: 'photo', media: { data: new Uint8Array([9]), filename: 'a.jpg' } },
      { type: 'photo', media: 'AgACAgIAAxkBAAIB' },
    ],
  });
  const form = h.calls[0]?.body as FormData;
  const media = JSON.parse(String(form.get('media')));
  assert.deepEqual(media, [
    { type: 'photo', media: 'attach://file0' },
    { type: 'photo', media: 'AgACAgIAAxkBAAIB' },
  ]);
  assert.ok(form.get('file0') instanceof Blob);
});

test('429 is retried after the server-specified delay', async () => {
  const h = harness([
    fail(429, { error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } }),
    ok({ message_id: 4, date: 0, chat: { id: 1, type: 'private' } }),
  ]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  const msg = await client.sendMessage({ chat_id: 1, text: 'x' });
  assert.equal(msg.message_id, 4);
  assert.deepEqual(h.sleeps, [2000]);
  assert.equal(h.calls.length, 2);
});

test('429 with a retry_after above the cap fails without a second attempt', async () => {
  const h = harness([fail(429, { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 500 } })]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep, maxRetryAfterSeconds: 60 });
  await assert.rejects(client.sendMessage({ chat_id: 1, text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof BotApiHttpError);
    assert.equal(err.retryAfter, 500);
    assert.match(err.message, /exceeds the 60s cap/);
    return true;
  });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
});

test('a transient 5xx is retried for read-only methods', async () => {
  const h = harness([
    fail(500, { error_code: 500, description: 'Internal Server Error' }),
    ok({ id: 1, is_bot: true, first_name: 'Bot' }),
  ]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  assert.equal((await client.getMe()).id, 1);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [250]);
});

test('a transient 5xx is never retried for send methods', async () => {
  const h = harness([fail(500, { error_code: 500, description: 'Internal Server Error' })]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  await assert.rejects(client.sendMessage({ chat_id: 1, text: 'x' }), BotApiHttpError);
  assert.equal(h.calls.length, 1);
});

test('ok:false maps to BotApiHttpError with Telegram fields and no retry', async () => {
  const h = harness([
    fail(400, {
      error_code: 400,
      description: 'Bad Request: chat not found',
      parameters: { migrate_to_chat_id: -1001234567890 },
    }),
  ]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  await assert.rejects(client.sendMessage({ chat_id: 1, text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof BotApiHttpError);
    assert.equal(err.method, 'sendMessage');
    assert.equal(err.errorCode, 400);
    assert.equal(err.description, 'Bad Request: chat not found');
    assert.equal(err.migrateToChatId, -1001234567890);
    assert.equal(err.code, 'BOT_API_HTTP');
    return true;
  });
  assert.equal(h.calls.length, 1);
});

test('a network failure is reported without the token and without a send retry', async () => {
  const cause = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
  const h = harness([{ throws: new TypeError('fetch failed', { cause }) }]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  await assert.rejects(client.sendMessage({ chat_id: 1, text: 'x' }), (err: unknown) => {
    assert.ok(err instanceof BotApiHttpError);
    assert.match(err.message, /network failure \(ECONNRESET\)/);
    assert.match(err.message, /may or may not have been processed/);
    assert.equal(err.message.includes(TOKEN), false);
    assert.equal(JSON.stringify(err).includes(TOKEN), false);
    return true;
  });
  assert.equal(h.calls.length, 1);
});

test('a read-only method is retried after a network failure', async () => {
  const h = harness([{ throws: new TypeError('fetch failed') }, ok({ id: 2, is_bot: true, first_name: 'B' })]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  assert.equal((await client.getMe()).id, 2);
  assert.equal(h.calls.length, 2);
});

test('a non-JSON response is surfaced with the HTTP status after retries are exhausted', async () => {
  const replies: Reply[] = [0, 1, 2, 3].map(() => ({ status: 502, body: '<html>bad gateway</html>' as unknown }));
  const h = harness(replies);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep, maxRetries: 3 });
  await assert.rejects(client.getMe(), (err: unknown) => {
    assert.ok(err instanceof BotApiHttpError);
    assert.equal(err.errorCode, 502);
    assert.equal(err.description, 'response was not a Bot API envelope');
    return true;
  });
  assert.equal(h.calls.length, 4);
});

test('a custom base URL is used, with trailing slashes trimmed', async () => {
  const h = harness([ok({ id: 1, is_bot: true, first_name: 'B' })]);
  const client = new BotApiHttpClient({ token: TOKEN, baseUrl: 'http://localhost:8081/', fetch: h.fetchImpl, sleep: h.sleep });
  await client.getMe();
  assert.equal(h.calls[0]?.url, `http://localhost:8081/bot${TOKEN}/getMe`);
});

test('callRaw invokes an unknown method and returns the result unchanged', async () => {
  const h = harness([ok({ anything: [1, 2] })]);
  const client = new BotApiHttpClient({ token: TOKEN, fetch: h.fetchImpl, sleep: h.sleep });
  const raw = await client.callRaw<{ anything: number[] }>('futureMethod', { flag: true });
  assert.deepEqual(raw.anything, [1, 2]);
  assert.equal(h.calls[0]?.url, `https://api.telegram.org/bot${TOKEN}/futureMethod`);
  assert.deepEqual(JSON.parse(String(h.calls[0]?.body)), { flag: true });
});

test('a getUpdates long poll gets a request timeout longer than its poll window', async () => {
  let seen: AbortSignal | undefined;
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    seen = init?.signal ?? undefined;
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }) as typeof fetch;
  const client = new BotApiHttpClient({ token: TOKEN, fetch: fetchImpl, timeoutMs: 1000 });
  await client.getUpdates({ timeout: 50 });
  assert.ok(seen, 'a signal is attached');
  assert.equal(seen.aborted, false);
});

test('the constructor rejects a missing token', () => {
  assert.throws(() => new BotApiHttpClient({ token: '' }), TypeError);
});

test('isInputFile recognises file content and rejects strings and plain objects', () => {
  assert.equal(isInputFile('AgACAgI'), false);
  assert.equal(isInputFile('https://example.com/a.jpg'), false);
  assert.equal(isInputFile({ id: 1 }), false);
  assert.equal(isInputFile(new Uint8Array([1])), true);
  assert.equal(isInputFile(new Blob(['x'])), true);
  assert.equal(isInputFile({ data: new Uint8Array([1]), filename: 'f' }), true);
});
