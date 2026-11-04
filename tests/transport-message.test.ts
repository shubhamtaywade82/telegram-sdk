/**
 * Transport framing and MTProto message packing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, TransportError } from '../src/mtproto/transports.js';
import { MTProtoSession } from '../src/mtproto/session.js';
import { packEncryptedMessage, packUnencryptedMessage, parseEncryptedMessage, parseUnencryptedMessage } from '../src/mtproto/message.js';
import { TLReader } from '../src/binary.js';
import { secureRandom } from '../src/utils.js';
import * as sdk from '../src/index.js';

test('abridged: hello + round-trip + 0x7f escape + split chunks', () => {
  const t = createTransport('abridged');
  assert.deepEqual([...t.hello()], [0xef]);
  const small = secureRandom(16);
  assert.deepEqual(t.feed(t.encode(small)), [small]);
  const big = secureRandom(2048); // 512 quarters -> 0x7f escape path
  const frame = t.encode(big);
  assert.equal(frame[0], 0x7f);
  // feed in two awkward chunks
  const mid = Math.floor(frame.length / 2) + 1;
  const out1 = t.feed(frame.subarray(0, mid));
  const out2 = t.feed(frame.subarray(mid));
  assert.deepEqual([...out1, ...out2], [big]);
});

test('intermediate: round-trip + negative length error', () => {
  const t = createTransport('intermediate');
  assert.deepEqual([...t.hello()], [0xee, 0xee, 0xee, 0xee]);
  const payload = secureRandom(64);
  assert.deepEqual(t.feed(t.encode(payload)), [payload]);
  const errFrame = new Uint8Array(4);
  new DataView(errFrame.buffer).setInt32(0, -4, true);
  assert.throws(() => t.feed(errFrame), (e: unknown) => e instanceof TransportError && e.code === -4);
});

test('full: round-trip + CRC tamper detection', () => {
  const t = createTransport('full');
  assert.deepEqual([...t.hello()], [0xef, 0x00, 0x00, 0x00]);
  const payload = secureRandom(48);
  assert.deepEqual(t.feed(t.encode(payload)), [payload]);
  const frame = Buffer.from(t.encode(payload));
  frame[frame.length - 1] ^= 0xff;
  assert.throws(() => t.feed(frame), /CRC32/);
});

test('full: CRC32 is standard IEEE (independent implementation + check value)', () => {
  // Independent table-based CRC-32/IEEE in the test, itself pinned by the
  // canonical check value crc32('123456789') = 0xCBF43926, then compared
  // against the CRC the transport actually puts on the wire.
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (data: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of data) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);

  const t = createTransport('full');
  for (const size of [0, 1, 7, 48, 256]) {
    const payload = secureRandom(size);
    const frame = Buffer.from(t.encode(payload));
    const len = frame.readInt32LE(0);
    assert.equal(frame.readUInt32LE(4 + len), crc32(frame.subarray(0, 4 + len)));
  }
});

test('unencrypted message round-trip', () => {
  const session = new MTProtoSession();
  const body = sdk.serializeTLObject(sdk.tl('resPQ', { nonce: 1n, server_nonce: 2n, pq: new Uint8Array([9]), server_public_key_fingerprints: [3n] })).toBuffer();
  const packet = packUnencryptedMessage(session, body);
  const { msgId, body: back } = parseUnencryptedMessage(new TLReader(packet));
  assert.deepEqual(back, body);
  assert.ok(msgId % 4n === 0n, 'client msg_id must be divisible by 4');
  assert.ok(msgId > 0n);
});

test('encrypted message round-trip and seq_no progression (x=0)', () => {
  const session = new MTProtoSession();
  session.setAuthKey(secureRandom(256));
  const body1 = secureRandom(48); // any bytes work
  const body2 = secureRandom(64);

  const p1 = packEncryptedMessage(session, body1, true);
  const in1 = parseEncryptedMessage(session, p1, 0);
  assert.deepEqual(in1.body, body1);
  assert.equal(in1.sessionId, session.sessionId);
  assert.ok(in1.seqNo % 2 === 1, 'content messages have odd seq_no');

  const p2 = packEncryptedMessage(session, body2, false);
  const in2 = parseEncryptedMessage(session, p2, 0);
  assert.deepEqual(in2.body, body2);
  assert.ok(in2.seqNo % 2 === 0, 'non-content messages have even seq_no');
  assert.ok(in2.seqNo > in1.seqNo);

  // default x=8 must fail on a client-packed message
  assert.throws(() => parseEncryptedMessage(session, p1, 8), /msg_key mismatch/);
});
