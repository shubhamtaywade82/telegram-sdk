import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BOT_API_VERSION } from '../src/index.js';

/** Finds the package root from source (tests/) or compiled output (dist/tests/). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('package.json not found above ' + import.meta.url);
    dir = up;
  }
  return dir;
}
const root = repoRoot();
const snapshotName = readdirSync(join(root, 'schema/bot-api')).filter((f) => /^bot-api-.*\.json$/.test(f)).sort().pop();
assert.ok(snapshotName, 'a Bot API snapshot is committed');
const snapshot = JSON.parse(readFileSync(join(root, 'schema/bot-api', snapshotName), 'utf8')) as {
  botApiVersion: string;
  types: Array<{ name: string }>;
  methods: Array<{ name: string; returns: string | null; params: Array<{ name: string; required: boolean }> }>;
};
const clientSource = readFileSync(join(root, 'src/botapi/generated/client.ts'), 'utf8');
const methodsSource = readFileSync(join(root, 'src/botapi/generated/methods.ts'), 'utf8');

test('the committed snapshot is complete for Bot API 10.3', () => {
  assert.equal(snapshot.botApiVersion, '10.3');
  assert.equal(BOT_API_VERSION, '10.3');
  assert.ok(snapshot.methods.length >= 180, `expected the full method set, got ${snapshot.methods.length}`);
  assert.ok(snapshot.types.length >= 390, `expected the full type set, got ${snapshot.types.length}`);
});

test('every snapshot method has a generated typed client method', () => {
  for (const m of snapshot.methods) {
    assert.match(clientSource, new RegExp(`\\n  ${m.name}\\(`), `missing ${m.name}`);
    assert.match(methodsSource, new RegExp(`\\n  ${m.name}: \\{ params: `), `missing map entry for ${m.name}`);
  }
});

test('every method has a resolved return type', () => {
  for (const m of snapshot.methods) {
    assert.ok(m.returns, `${m.name} has no return type`);
  }
});

test('required parameters are required in the generated interfaces', () => {
  const sendMessage = snapshot.methods.find((m) => m.name === 'sendMessage');
  assert.ok(sendMessage);
  const required = sendMessage.params.filter((p) => p.required).map((p) => p.name);
  assert.deepEqual(required, ['chat_id', 'text']);
  assert.match(methodsSource, /export interface SendMessageParams \{[\s\S]*?\n  chat_id: /);
  assert.match(clientSource, /sendMessage\(params: Methods\.SendMessageParams\)/);
});

test('zero-argument methods take no parameters in their generated signature', () => {
  assert.match(clientSource, /\n  getMe\(\): Promise</);
});

test('the generated result for sendMessage is the Message object', () => {
  assert.match(methodsSource, /sendMessage: \{ params: SendMessageParams; result: Types\.Message \}/);
});
