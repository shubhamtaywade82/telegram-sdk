/**
 * TL dynamic layer round-trips against the real generated schema.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import * as sdk from '../src/index.js';
import { TLReader, TLWriter } from '../src/binary.js';
import { bytesToHex, secureRandom } from '../src/utils.js';

test('registry: full layer loaded', () => {
  assert.ok(sdk.registry.methodByName('auth.sendCode'), 'auth.sendCode must be registered');
  assert.ok(sdk.registry.constructorByName('messageEntityBold'));
  assert.ok(sdk.registry.constructorByName('resPQ'));
  assert.ok(sdk.ALL_CONSTRUCTORS.length > 1500, `expected a full layer, got ${sdk.ALL_CONSTRUCTORS.length}`);
  assert.ok(sdk.ALL_METHODS.length > 500);
  assert.equal(sdk.LAYER, 232);
});

test('flags round-trip (codeSettings)', () => {
  // Layer-232 codeSettings#ad253d78: `token` is the only flags.N?string field
  // and shares bit 8 with `app_sandbox` (flags.8?Bool), so both serialize.
  const obj = sdk.tl('codeSettings', { token: 'abc', allow_flashcall: true, app_sandbox: true });
  const buf = sdk.serializeTLObject(obj).toBuffer();
  const back = sdk.parseTLObject(new TLReader(buf));
  assert.equal(back.name, 'codeSettings');
  assert.equal(back.args.token, 'abc'); // ?string flag, bit set
  assert.equal(back.args.allow_flashcall, true); // ?true flag, bit set
  assert.equal(back.args.allow_missed_call, false); // ?true flag, bit clear
  assert.equal(back.args.logout_tokens, undefined); // absent optional
  // with its flag bit clear, the only ?string field is absent
  const bare = sdk.parseTLObject(new TLReader(sdk.serializeTLObject(sdk.tl('codeSettings', {})).toBuffer()));
  assert.equal(bare.args.token, undefined);
});

test('vector<long> round-trip (resPQ)', () => {
  const pq = secureRandom(8);
  const fps = [1n, -2n, 0x7ffffffffffffffen];
  const obj = sdk.tl('resPQ', {
    nonce: 0x1122334455667788n,
    server_nonce: 0x99aabbccddeeff00n,
    pq,
    server_public_key_fingerprints: fps,
  });
  const buf = sdk.serializeTLObject(obj).toBuffer();
  const back = sdk.parseTLObject(new TLReader(buf));
  assert.equal(back.name, 'resPQ');
  assert.equal(back.args.nonce, 0x1122334455667788n);
  assert.equal(bytesToHex(back.args.pq as Uint8Array), bytesToHex(pq));
  assert.deepEqual(back.args.server_public_key_fingerprints, fps);
});

test('nested objects + entities round-trip (messages.sendMessage)', () => {
  const method = sdk.tlMethod('messages.sendMessage', {
    peer: sdk.tl('inputPeerUser', { user_id: 7n, access_hash: 9n }),
    message: 'hi there',
    random_id: 42n,
    entities: [sdk.tl('messageEntityBold', { offset: 3, length: 5 })],
  });
  const buf = sdk.serializeTLObject(method).toBuffer();
  const back = sdk.parseTLObject(new TLReader(buf));
  assert.equal(back.name, 'messages.sendMessage');
  const peer = back.args.peer as sdk.TLObject;
  assert.equal(peer.name, 'inputPeerUser');
  assert.equal(peer.args.user_id, 7n);
  const entities = back.args.entities as sdk.TLObject[];
  assert.equal(entities.length, 1);
  assert.equal(entities[0]!.name, 'messageEntityBold');
  assert.equal(entities[0]!.args.offset, 3);
});

test('gzip_packed is transparent', () => {
  const big = 'x'.repeat(4096);
  const obj = sdk.tl('messageEntityPre', { offset: 0, length: 4096, language: big });
  const plain = sdk.serializeTLObject(obj).toBuffer();
  const w = new TLWriter();
  w.writeUint(sdk.GZIP_PACKED_ID);
  w.writeBytes(gzipSync(plain));
  const back = sdk.parseTLObject(new TLReader(w.toBuffer()));
  assert.equal(back.name, 'messageEntityPre');
  assert.equal(back.args.language, big);
});

test('top-level bare vector is rejected with a clear message', () => {
  const w = new TLWriter();
  w.writeUint(sdk.TL_VECTOR_ID);
  w.writeInt(0);
  assert.throws(() => sdk.parseTLObject(new TLReader(w.toBuffer())), /parseResult/);
});

test('unknown constructor id throws', () => {
  const w = new TLWriter();
  w.writeUint(0xdeadbeef);
  assert.throws(() => sdk.parseTLObject(new TLReader(w.toBuffer())), /unknown TL constructor/);
});
