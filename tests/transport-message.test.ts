/**
 * Transport framing and MTProto message packing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { createTransport, TransportError } from '../src/mtproto/transports.js';
import { MTProtoSession } from '../src/mtproto/session.js';
import { packEncryptedMessage, packUnencryptedMessage, parseEncryptedMessage, parseUnencryptedMessage } from '../src/mtproto/message.js';
import { TLReader } from '../src/binary.js';
import { secureRandom } from '../src/utils.js';
import * as sdk from '../src/index.js';

// node:zlib.crc32 exists only on Node >= 20.15 / 22.2 (not in the 18 types)
const zlibCrc32: ((data: Uint8Array) => number) | undefined =
  typeof (zlib as unknown as { crc32?: unknown }).crc32 === 'function'
    ? (zlib as unknown as { crc32: (data: Uint8Array) => number }).crc32
    : undefined;

// Independent table-driven CRC-32/IEEE (pinned by the canonical check value).
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

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

test('full: documented framing (len includes itself, seq from 0, no magic bytes)', () => {
  const t = createTransport('full');
  assert.equal(t.hello().length, 0, 'the full transport sends no hello bytes');

  // Reference encoder written directly from the spec:
  // len(4, counts itself+seq+payload+crc) + seq(4, from 0) + payload + crc32(len|seq|payload)
  const refFrame = (payload: Uint8Array, seq: number): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(payload.length + 12, 0);
    header.writeUInt32LE(seq, 4);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(Buffer.concat([header, Buffer.from(payload)])), 0);
    return Buffer.concat([header, Buffer.from(payload), crc]);
  };

  const p1 = secureRandom(48);
  const p2 = secureRandom(64);
  const f1 = Buffer.from(t.encode(p1));
  const f2 = Buffer.from(t.encode(p2));
  assert.equal(f1.readUInt32LE(0), p1.length + 12, 'length counts the whole packet');
  assert.deepEqual(f1, refFrame(p1, 0), 'first packet: seq 0');
  assert.deepEqual(f2, refFrame(p2, 1), 'second packet: seq 1');

  // decoding reference-built frames (incoming seq is read but not enforced)
  const t2 = createTransport('full');
  assert.deepEqual(t2.feed(refFrame(p1, 7)), [p1]);
  assert.deepEqual(t2.feed(f2), [p2]);
});

test('full: CRC tamper detection', () => {
  const t = createTransport('full');
  const payload = secureRandom(48);
  const frame = Buffer.from(t.encode(payload));
  frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0xff;
  assert.throws(() => t.feed(frame), /CRC32/);
});

test('full: byte-at-a-time reassembly (linear buffering)', () => {
  const t = createTransport('full');
  const payload = secureRandom(300);
  const frame = t.encode(payload);
  const out: Uint8Array[] = [];
  for (const byte of frame) out.push(...t.feed(Uint8Array.of(byte)));
  assert.deepEqual(out, [payload]);
});

test('full: CRC32 is standard IEEE (check value + zlib differential on new Node)', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);

  const t = createTransport('full');
  for (const size of [0, 1, 7, 48, 256]) {
    const payload = secureRandom(size);
    const frame = Buffer.from(t.encode(payload));
    const total = frame.readUInt32LE(0);
    assert.equal(frame.readUInt32LE(total - 4), crc32(frame.subarray(0, total - 4)));
  }

  // differential against node:zlib (crc32 exists since 20.15.0 / 22.2.0)
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const hasZlibCrc32 = typeof zlibCrc32 === 'function' && (major > 20 || (major === 20 && minor >= 15) || (major === 22 && minor >= 2));
  if (hasZlibCrc32) {
    for (let i = 0; i < 50; i++) {
      const data = secureRandom(1 + Math.floor(Math.random() * 512));
      assert.equal(crc32(data), zlibCrc32(data), `zlib differential failed at iteration ${i}`);
    }
  }
});

test('transports reject oversized frames before allocating', () => {
  for (const name of ['abridged', 'intermediate', 'full'] as const) {
    const t = createTransport(name);
    // hand-craft a header claiming a huge payload
    const header =
      name === 'abridged'
        ? new Uint8Array([0x7f, 0xff, 0xff, 0xff]) // ~256 MiB payload
        : name === 'intermediate'
          ? (() => {
              const h = new Uint8Array(4);
              new DataView(h.buffer).setInt32(0, 64 * 1024 * 1024, true);
              return h;
            })()
          : (() => {
              const h = new Uint8Array(8);
              new DataView(h.buffer).setUint32(0, 64 * 1024 * 1024 + 12, true);
              return h;
            })();
    assert.throws(() => t.feed(header), /exceeds the .*-byte limit/, `${name} must reject huge frames`);
    assert.throws(
      () => t.encode(secureRandom(17 * 1024 * 1024)),
      /limit/,
      `${name} must refuse to encode oversized payloads`,
    );
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

test('encrypted message padding is randomized within 12..1024 and aligns to 16', () => {
  const session = new MTProtoSession();
  session.setAuthKey(secureRandom(256));
  const lengths = new Set<number>();
  for (let i = 0; i < 32; i++) {
    const p = packEncryptedMessage(session, secureRandom(48), true);
    // ciphertext = payload - 8 (auth_key_id) - 16 (msg_key); plaintext = ciphertext
    // total plaintext = 32 + body(48) + pad, and pad in [12, 27] + 16k
    lengths.add(p.length);
  }
  // random padding means the same body length yields varying packet sizes
  assert.ok(lengths.size > 1, `padding must vary, saw sizes ${[...lengths].join(',')}`);
  for (const len of lengths) {
    assert.equal((len - 8 - 16) % 16, 0, 'plaintext (incl. padding) must be 16-byte aligned');
    const pad = len - 8 - 16 - 32 - 48;
    assert.ok(pad >= 12 && pad <= 1024, `padding ${pad} out of the 12..1024 range`);
  }
});
