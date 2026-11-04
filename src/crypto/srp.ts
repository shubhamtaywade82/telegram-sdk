/**
 * Two-factor password check (SRP) exactly as specified by
 * core.telegram.org/api/srp. Produces the values needed for
 * `inputCheckPasswordSRP#d27ff082 srp_id:long A:bytes M1:bytes`.
 *
 * All numbers fed to hashing functions are big-endian and padded to
 * 2048 bits; all math is modulo p.
 *
 * @module
 */

import { createHash, pbkdf2Sync } from 'node:crypto';
import { bigFromBytesBE, bytesFromBigBE, modPow, secureRandom } from '../utils.js';
import { checkDhParams, validateDhValue } from './dh.js';

/** The KDF algorithm parameters from `account.password`. */
export interface SrpAlgo {
  /** Generator (2..7). */
  readonly g: number;
  /** 2048-bit safe prime, big-endian (256 bytes). */
  readonly p: Uint8Array;
  readonly salt1: Uint8Array;
  readonly salt2: Uint8Array;
}

/** The server-side values from `account.password`. */
export interface SrpServerState {
  readonly srpId: bigint;
  /** `srp_B`, big-endian. */
  readonly srpB: Uint8Array;
}

/** What to send in `inputCheckPasswordSRP`. */
export interface SrpCheck {
  readonly srpId: bigint;
  /** `g_a` as 256 big-endian bytes (the `A` field). */
  readonly A: Uint8Array;
  /** 32-byte proof. */
  readonly M1: Uint8Array;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 256-byte big-endian representation (zero-padded). */
function be2048(value: bigint): Uint8Array {
  return bytesFromBigBE(value, 256);
}

/**
 * Compute the SRP check for a user password.
 *
 *  x = PH2(password, salt1, salt2)
 *  v = g^x mod p;  k = H(p | g);  u = H(g_a | g_b)
 *  a = random 2048-bit;  g_a = g^a mod p
 *  k_v = (k * v) mod p;  t = (g_b - k_v) mod p  (positive modulo)
 *  s_a = t^(a + u*x) mod p;  k_a = H(s_a)
 *  M1 = H(H(p) xor H(g) | H(salt1) | H(salt2) | g_a | g_b | k_a)
 */
export function computeSrpCheck(password: string, algo: SrpAlgo, server: SrpServerState): SrpCheck {
  if (algo.p.length !== 256) throw new RangeError(`srp p must be 256 bytes, got ${algo.p.length}`);
  const p = bigFromBytesBE(algo.p);
  const g = BigInt(algo.g);
  const gB = bigFromBytesBE(server.srpB);

  checkDhParams(algo.g, p);
  validateDhValue(gB, p, 'srp_B');

  // --- password hashes (PH1 / PH2) ---
  const pw = Buffer.from(password, 'utf8');
  const s1 = algo.salt1;
  const s2 = algo.salt2;
  // PH1 = H(salt2 | H(salt1 | password | salt1) | salt2)
  const ph1 = sha256(concat(s2, sha256(concat(s1, pw, s1)), s2));
  // PH2 = H(salt2 | pbkdf2(sha512, PH1, salt1, 100000, 64) | salt2)
  const dk = pbkdf2Sync(ph1, s1, 100000, 64, 'sha512');
  const ph2 = sha256(concat(s2, dk, s2));
  const x = bigFromBytesBE(ph2);

  // --- shared values ---
  const gPadded = be2048(g);
  const k = bigFromBytesBE(sha256(concat(algo.p, gPadded)));
  const v = modPow(g, x, p);

  // --- client ephemeral ---
  const aBytes = secureRandom(256);
  aBytes[0] |= 0x80;
  const a = bigFromBytesBE(aBytes);
  const gA = modPow(g, a, p);
  const gABytes = be2048(gA);
  const gBBytes = be2048(gB);
  const u = bigFromBytesBE(sha256(concat(gABytes, gBBytes)));

  // --- session key ---
  const k_v = (k * v) % p;
  let t = (gB - k_v) % p;
  if (t < 0n) t += p;
  const s_a = modPow(t, a + u * x, p);
  const k_a = sha256(be2048(s_a));

  // --- M1 ---
  const hp = sha256(algo.p);
  const hg = sha256(gPadded);
  const hpXorHg = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hpXorHg[i] = hp[i] ^ hg[i];
  const m1 = sha256(concat(hpXorHg, sha256(s1), sha256(s2), gABytes, gBBytes, k_a));

  return { srpId: server.srpId, A: gABytes, M1: m1 };
}
