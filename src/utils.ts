/**
 * General-purpose helpers shared across the SDK.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cryptographically secure random bytes. */
export function secureRandom(length: number): Buffer {
  if (length < 0) throw new RangeError('length must be >= 0');
  return randomBytes(length);
}

/** Uniform random integer in [0, maxExclusive) (rejection sampling). */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('maxExclusive must be a positive integer');
  }
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  for (;;) {
    const v = randomBytes(4).readUInt32BE(0);
    if (v < limit) return v % maxExclusive;
  }
}

/**
 * Random 63-bit positive `long` (sign bit clear), as used for session ids,
 * message random bits and file ids.
 */
export function randomLong(): bigint {
  const buf = randomBytes(8);
  buf[7] = (buf[7] ?? 0) & 0x7f;
  return buf.readBigInt64LE(0);
}

/** Fast modular exponentiation; `mod` must be positive. Handles negative bases. */
export function modPow(base: bigint, exponent: bigint, mod: bigint): bigint {
  if (mod <= 0n) throw new RangeError('mod must be positive');
  if (mod === 1n) return 0n;
  if (exponent < 0n) throw new RangeError('negative exponents are not supported');
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Lowercase hex of a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Parse a (possibly `0x`-prefixed) lowercase/uppercase hex string into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new TypeError('hex string must have even length');
  const out = new Uint8Array(s.length / 2);
  const DIGITS = '0123456789abcdef';
  for (let i = 0; i < out.length; i++) {
    const hi = DIGITS.indexOf(s[i * 2]!.toLowerCase());
    const lo = DIGITS.indexOf(s[i * 2 + 1]!.toLowerCase());
    if (hi < 0 || lo < 0) throw new TypeError(`invalid hex digit at ${i * 2}`);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Interpret bytes as an unsigned big-endian integer. */
export function bigFromBytesBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Unsigned big-endian serialization; `value` must be >= 0. Zero-pads to `length` when given. */
export function bytesFromBigBE(value: bigint, length?: number): Uint8Array {
  if (value < 0n) throw new RangeError('value must be >= 0');
  const hex = value.toString(16);
  const size = length ?? Math.max(1, Math.ceil(hex.length / 2));
  if (value >= 1n << BigInt(8 * size)) throw new RangeError('value does not fit in the requested length');
  const out = new Uint8Array(size);
  let v = value;
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Constant-time-ish comparison of two byte arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
