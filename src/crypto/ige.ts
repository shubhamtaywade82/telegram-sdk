/**
 * AES-256 in IGE (Infinite Garble Extension) mode, as required by MTProto 2.0.
 *
 * IGE is not exposed by Node's crypto, so it is built here on top of the
 * AES-ECB primitive. The IV is 32 bytes: the first 16 are the previous
 * ciphertext block (y_{i-1}), the second 16 the previous plaintext block
 * (x_{i-1}).
 *
 *   encrypt: c_i = E(p_i ^ c_{i-1}) ^ p_{i-1}
 *   decrypt: p_i = D(c_i ^ p_{i-1}) ^ c_{i-1}
 *
 * @module
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';

function assertArgs(data: Uint8Array, key: Uint8Array, iv: Uint8Array): void {
  if (key.length !== 32) throw new RangeError(`AES-256-IGE key must be 32 bytes, got ${key.length}`);
  if (iv.length !== 32) throw new RangeError(`AES-256-IGE IV must be 32 bytes, got ${iv.length}`);
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new RangeError(`AES-256-IGE data length must be a positive multiple of 16, got ${data.length}`);
  }
}

/** Encrypt `data` (multiple of 16 bytes) with AES-256-IGE. */
export function ige256Encrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  assertArgs(data, key, iv);
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  const prevCipher = Buffer.from(iv.subarray(0, 16));
  const prevPlain = Buffer.from(iv.subarray(16, 32));
  const out = Buffer.alloc(data.length);
  const block = Buffer.alloc(16);
  for (let off = 0; off < data.length; off += 16) {
    for (let i = 0; i < 16; i++) block[i] = data[off + i]! ^ prevCipher[i]!;
    const encrypted = cipher.update(block) as Buffer;
    for (let i = 0; i < 16; i++) out[off + i] = encrypted[i]! ^ prevPlain[i]!;
    out.subarray(off, off + 16).copy(prevCipher);
    prevPlain.set(data.subarray(off, off + 16));
  }
  cipher.final();
  return out;
}

/** Decrypt `data` (multiple of 16 bytes) with AES-256-IGE. */
export function ige256Decrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  assertArgs(data, key, iv);
  const decipher = createDecipheriv('aes-256-ecb', key, null);
  decipher.setAutoPadding(false);
  const prevCipher = Buffer.from(iv.subarray(0, 16));
  const prevPlain = Buffer.from(iv.subarray(16, 32));
  const out = Buffer.alloc(data.length);
  const block = Buffer.alloc(16);
  for (let off = 0; off < data.length; off += 16) {
    for (let i = 0; i < 16; i++) block[i] = data[off + i]! ^ prevPlain[i]!;
    const decrypted = decipher.update(block) as Buffer;
    for (let i = 0; i < 16; i++) out[off + i] = decrypted[i]! ^ prevCipher[i]!;
    out.subarray(off, off + 16).copy(prevPlain);
    prevCipher.set(data.subarray(off, off + 16));
  }
  decipher.final();
  return out;
}
