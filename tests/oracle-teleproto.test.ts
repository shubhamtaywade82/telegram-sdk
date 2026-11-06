/**
 * Independent-implementation oracles. These tests do not use the network. Each one feeds the same
 * inputs to this SDK and to a separately maintained library and requires identical outputs:
 *
 *   - teleproto (layer 232, MIT): TL serialisation of methods and objects, including `flags`.
 *   - cifrante (AES-IGE): the MTProto IGE mode used by the handshake and message encryption.
 *
 * A negative control confirms that the comparison can fail, so a passing run means something.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { aes } from 'cifrante';
import { wrapWithInitConnection } from '../src/client/telegram-client.js';
import {
  LAYER,
  ige256Decrypt,
  ige256Encrypt,
  serializeTLObject,
  tl,
  tlMethod,
  TLWriter,
} from '../src/index.js';

const requireFrom = createRequire(import.meta.url);
// teleproto is CommonJS and exposes its generated classes under `Api`.
const teleproto = requireFrom('teleproto/tl') as {
  LAYER: number;
  Api: Record<string, any>;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const sdkBytes = (obj: unknown): string => {
  const writer = serializeTLObject(obj as never, new TLWriter());
  return hex(writer.toBuffer());
};

/** Deterministic pseudo-random bytes so failures are reproducible. */
function seeded(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

test('the layer constant matches teleproto (both are layer 232)', () => {
  assert.equal(LAYER, teleproto.LAYER);
  assert.equal(LAYER, 232);
});

const serializationCases: Array<[string, () => string, () => string]> = [
  [
    'help.getConfig',
    () => new teleproto.Api['help']!.GetConfig().getBytes().toString('hex'),
    () => sdkBytes(tlMethod('help.getConfig', {})),
  ],
  [
    'messages.getHistory (int, long, peer union)',
    () =>
      new teleproto.Api['messages']!.GetHistory({
        peer: new teleproto.Api['InputPeerSelf'](),
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: 10,
        maxId: 0,
        minId: 0,
        hash: 0n,
      })
        .getBytes()
        .toString('hex'),
    () =>
      sdkBytes(
        tlMethod('messages.getHistory', {
          peer: tl('inputPeerSelf', {}),
          offset_id: 0,
          offset_date: 0,
          add_offset: 0,
          limit: 10,
          max_id: 0,
          min_id: 0,
          hash: 0n,
        }),
      ),
  ],
  [
    'auth.sendCode (strings, nested codeSettings with a flags bit)',
    () =>
      new teleproto.Api['auth']!.SendCode({
        phoneNumber: '+15555550100',
        apiId: 12345,
        apiHash: 'abcdef',
        settings: new teleproto.Api['CodeSettings']({ allowFlashcall: true }),
      })
        .getBytes()
        .toString('hex'),
    () =>
      sdkBytes(
        tlMethod('auth.sendCode', {
          phone_number: '+15555550100',
          api_id: 12345,
          api_hash: 'abcdef',
          settings: tl('codeSettings', { allow_flashcall: true }),
        }),
      ),
  ],
  [
    'codeSettings with an extra flag (allow_app_hash)',
    () => new teleproto.Api['CodeSettings']({ allowFlashcall: true, allowAppHash: true }).getBytes().toString('hex'),
    () => sdkBytes(tl('codeSettings', { allow_flashcall: true, allow_app_hash: true })),
  ],
];

for (const [name, theirs, ours] of serializationCases) {
  test(`TL serialisation matches teleproto: ${name}`, () => {
    assert.equal(ours(), theirs());
  });
}

test('negative control: a flags mismatch is detected by the comparison', () => {
  const theirs = new teleproto.Api['CodeSettings']({ allowFlashcall: true }).getBytes().toString('hex');
  const ours = sdkBytes(tl('codeSettings', {}));
  assert.notEqual(ours, theirs, 'a deliberate difference must not compare equal');
});

const igeCases: Array<[number, number]> = [
  [16, 1],
  [32, 2],
  [256, 3],
  [1024, 4],
];

for (const [size, seed] of igeCases) {
  test(`AES-256-IGE matches cifrante for ${size} bytes (encrypt and decrypt)`, () => {
    const key = seeded(32, seed * 7919);
    const iv = seeded(32, seed * 104729);
    const plain = seeded(size, seed * 1299709);

    const ours = ige256Encrypt(plain, key, iv);
    const theirs = aes.ige(key).encryptSync(plain, { iv });
    assert.equal(hex(ours), hex(theirs), 'ciphertext must be identical');

    const roundTrip = ige256Decrypt(Buffer.from(theirs), key, iv);
    assert.equal(hex(roundTrip), hex(plain), 'the SDK must decrypt the independent ciphertext');
  });
}

test('negative control: a different IV produces different AES-IGE output', () => {
  const key = seeded(32, 11);
  const plain = seeded(64, 13);
  const a = ige256Encrypt(plain, key, seeded(32, 17));
  const b = aes.ige(key).encryptSync(plain, { iv: seeded(32, 19) });
  assert.notEqual(hex(a), hex(b));
});

test('the connection init wrapper matches teleproto: invokeWithLayer(232, initConnection(help.getConfig))', () => {
  // The codegen skips generic wrappers ({X:Type}), so this path is hand-serialised in the client.
  // The oracle pins its bytes against an independent encoder.
  const device = { model: 'mtproto-sdk', system: `${process.platform} Node ${process.version}` };
  const ours = hex(
    wrapWithInitConnection(tlMethod('help.getConfig', {}) as never, 12345, '1.2.3'),
  );
  const theirs = new teleproto.Api['InvokeWithLayer']({
    layer: 232,
    query: new teleproto.Api['InitConnection']({
      apiId: 12345,
      deviceModel: device.model,
      systemVersion: device.system,
      appVersion: '1.2.3',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
      query: new teleproto.Api['help']!.GetConfig(),
    }),
  })
    .getBytes()
    .toString('hex');
  assert.equal(ours, theirs);
});
