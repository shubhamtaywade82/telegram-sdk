/**
 * MTProto message packing: unencrypted (auth-key creation, time sync) and
 * encrypted (MTProto 2.0) messages.
 *
 * Encrypted layout on the wire:
 *   auth_key_id (8, LE) | msg_key (16) | IGE(salt 8 | session_id 8 |
 *   msg_id 8 | seq_no 4 | length 4 | data | padding 12..1024)
 * with, per the spec (x = 0 client->server, x = 8 server->client):
 *   msg_key_large = SHA256(auth_key[88+x .. 88+x+32] + plaintext)
 *   msg_key = msg_key_large[8..24]
 *   sha256_a = SHA256(msg_key + auth_key[x .. x+36])
 *   sha256_b = SHA256(auth_key[40+x .. 40+x+36] + msg_key)
 *   aes_key = sha256_a[0..8] + sha256_b[8..24] + sha256_a[24..32]
 *   aes_iv  = sha256_b[0..8] + sha256_a[8..24] + sha256_b[24..32]
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { TLReader, TLWriter } from '../binary.js';
import { ige256Decrypt, ige256Encrypt } from '../crypto/ige.js';
import { randomInt, secureRandom } from '../utils.js';
import type { MTProtoSession } from './session.js';

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

// ---------------------------------------------------------------------------
// unencrypted messages
// ---------------------------------------------------------------------------

/** Pack an unencrypted body (auth_key_id = 0). */
export function packUnencryptedMessage(session: MTProtoSession, body: Uint8Array): Buffer {
  const msgId = session.nextMsgId();
  const w = new TLWriter();
  w.writeLong(0n); // auth_key_id
  w.writeLong(msgId);
  w.writeUint(body.length);
  w.writeRaw(body);
  return w.toBuffer();
}

/** Parse an unencrypted message (the auth_key_id must be 0). */
export function parseUnencryptedMessage(reader: TLReader): { msgId: bigint; body: Uint8Array } {
  const authKeyId = reader.readLong();
  if (authKeyId !== 0n) {
    throw new Error(`expected unencrypted message (auth_key_id=0), got ${authKeyId}`);
  }
  const msgId = reader.readLong();
  const len = reader.readUint();
  return { msgId, body: reader.readRaw(len) };
}

// ---------------------------------------------------------------------------
// encrypted messages
// ---------------------------------------------------------------------------

/** An incoming encrypted message, after decryption and checks. */
export interface EncryptedIncoming {
  salt: bigint;
  sessionId: bigint;
  msgId: bigint;
  seqNo: number;
  body: Uint8Array;
}

function deriveKeyIv(authKey: Uint8Array, msgKey: Uint8Array, x: number): { key: Uint8Array; iv: Uint8Array } {
  const a = sha256(concatBytes(msgKey, authKey.subarray(x, x + 36)));
  const b = sha256(concatBytes(authKey.subarray(40 + x, 40 + x + 36), msgKey));
  const key = new Uint8Array(32);
  key.set(a.subarray(0, 8), 0);
  key.set(b.subarray(8, 24), 8);
  key.set(a.subarray(24, 32), 24);
  const iv = new Uint8Array(32);
  iv.set(b.subarray(0, 8), 0);
  iv.set(a.subarray(8, 24), 8);
  iv.set(b.subarray(24, 32), 24);
  return { key, iv };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Pack one encrypted message; `content` marks it content-related. */
export function packEncryptedMessage(
  session: MTProtoSession,
  body: Uint8Array,
  content: boolean,
  msgId?: bigint,
): Buffer {
  if (!session.authKey) throw new Error('cannot pack an encrypted message without an auth key');
  const w = new TLWriter();
  w.writeLong(session.serverSalt);
  w.writeLong(session.sessionId);
  const id = msgId ?? session.nextMsgId();
  w.writeLong(id);
  w.writeUint(session.nextSeqNo(content));
  w.writeUint(body.length);
  w.writeRaw(body);
  // padding: 12..1024 random bytes so the total length is a multiple of 16.
  // The length is randomized (not the deterministic minimum) to leak less
  // structure about the payload.
  const fixed = 32 + body.length; // internal header (16) + msg_id/seq/len (16) + data
  const minPad = 12;
  let pad = minPad;
  while ((fixed + pad) % 16 !== 0) pad += 1;
  pad += 16 * randomInt(64); // 0..63 extra blocks, still within the 1024-byte cap
  w.writeRaw(secureRandom(pad));
  const plaintext = w.toBuffer();

  const authKey = session.authKey;
  const msgKeyLarge = sha256(concatBytes(authKey.subarray(88, 120), plaintext));
  const msgKey = msgKeyLarge.subarray(8, 24);
  const { key, iv } = deriveKeyIv(authKey, msgKey, 0);
  const encrypted = ige256Encrypt(plaintext, key, iv);

  const out = new TLWriter();
  out.writeLong(session.authKeyId);
  out.writeRaw(msgKey);
  out.writeRaw(encrypted);
  return out.toBuffer();
}

/** Decrypt and check one incoming encrypted message (server->client uses x = 8). */
export function parseEncryptedMessage(session: MTProtoSession, payload: Uint8Array, x = 8): EncryptedIncoming {
  if (!session.authKey) throw new Error('cannot parse an encrypted message without an auth key');
  if (payload.length < 8 + 16 + 32) {
    throw new Error(`encrypted message too short: ${payload.length}`);
  }
  const reader = new TLReader(payload);
  const authKeyId = BigInt.asUintN(64, reader.readLong());
  if (authKeyId !== session.authKeyId) {
    throw new Error(`auth_key_id mismatch: expected ${session.authKeyId}, got ${authKeyId}`);
  }
  const msgKey = reader.readRaw(16);
  const encrypted = reader.readRaw(reader.remaining);
  const authKey = session.authKey;

  // MTProto 2.0: msg_key covers the *plaintext* body (salt..padding), so
  // decrypt first, then verify it over the recovered plaintext.
  const { key, iv } = deriveKeyIv(authKey, msgKey, x);
  const plaintext = ige256Decrypt(encrypted, key, iv);
  const msgKeyLarge = sha256(concatBytes(authKey.subarray(88 + x, 120 + x), plaintext));
  const expectedMsgKey = msgKeyLarge.subarray(8, 24);
  for (let i = 0; i < 16; i++) {
    if (msgKey[i] !== expectedMsgKey[i]) {
      throw new Error('msg_key mismatch: corrupted or forged message');
    }
  }

  const inner = new TLReader(plaintext);
  const salt = inner.readLong();
  const sessionId = inner.readLong();
  if (sessionId !== session.sessionId) {
    throw new Error(`session_id mismatch: expected ${session.sessionId}, got ${sessionId}`);
  }
  const msgId = inner.readLong();
  const seqNo = inner.readUint();
  const len = inner.readUint();
  const body = inner.readRaw(len);
  return { salt, sessionId, msgId, seqNo, body };
}
