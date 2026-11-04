/**
 * Crypto vectors and structural verifications.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, pbkdf2Sync, privateDecrypt } from 'node:crypto';
import { ige256Encrypt, ige256Decrypt } from '../src/crypto/ige.js';
import { factorizePQ, isProbablyPrime } from '../src/crypto/math.js';
import { checkDhParams, validateDhValue } from '../src/crypto/dh.js';
import { computeSrpCheck } from '../src/crypto/srp.js';
import { rsaPad, rsaPadLegacy, type TelegramRsaKey } from '../src/crypto/rsa.js';
import { bigFromBytesBE, bytesFromBigBE, bytesToHex, hexToBytes, modPow, secureRandom } from '../src/utils.js';

const KNOWN_PRIME_HEX =
  'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest();
const be256 = (v: bigint) => bytesFromBigBE(v, 256);

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

test('IGE round-trips', () => {
  for (const size of [16, 160, 1024]) {
    const key = secureRandom(32);
    const iv = secureRandom(32);
    const data = secureRandom(size);
    const enc = ige256Encrypt(data, key, iv);
    const dec = ige256Decrypt(enc, key, iv);
    assert.deepEqual(dec, Buffer.from(data), `size ${size}`);
  }
});

test('IGE garble extension: a flipped plaintext block garbles that block and every following ciphertext block', () => {
  const key = secureRandom(32);
  const iv = secureRandom(32);
  const data = secureRandom(48);
  const enc1 = ige256Encrypt(data, key, iv);
  const flipped = Buffer.from(data);
  flipped[0] ^= 0x80;
  const enc2 = ige256Encrypt(flipped, key, iv);
  assert.notDeepEqual(enc1.subarray(0, 16), enc2.subarray(0, 16), 'block 0 must change');
  assert.notDeepEqual(enc1.subarray(16, 32), enc2.subarray(16, 32), 'block 1 must change');
  // Unlike CBC, IGE feeds the previous ciphertext block back into the next
  // block's cipher input, so a plaintext flip garbles every following block.
  assert.notDeepEqual(enc1.subarray(32, 48), enc2.subarray(32, 48), 'block 2 must change too (infinite garble)');
});

test('factorizePQ on known semiprimes', () => {
  const cases: Array<[bigint, bigint]> = [
    [2147483647n, 2147483629n],
    [1000003n, 1000033n],
    [999999937n, 999999193n],
  ];
  for (const [p, q] of cases) {
    const pq = p * q;
    const r = factorizePQ(pq);
    assert.equal(r.p * r.q, pq);
    assert.ok(r.p < r.q);
    assert.ok(r.p === p || r.p === q);
  }
});

test('isProbablyPrime', () => {
  assert.ok(isProbablyPrime(2147483647n));
  assert.ok(isProbablyPrime(2n ** 61n - 1n));
  assert.ok(!isProbablyPrime(2147483647n * 2147483629n));
  assert.ok(!isProbablyPrime(1n));
});

test('checkDhParams on the known prime, and rejection of bad values', () => {
  const prime = bigFromBytesBE(hexToBytes(KNOWN_PRIME_HEX));
  const valid: number[] = [];
  for (let g = 2; g <= 7; g++) {
    try {
      checkDhParams(g, prime);
      valid.push(g);
    } catch {
      // not a valid generator for this prime
    }
  }
  assert.ok(valid.length >= 1, 'the known prime must accept at least one generator');
  assert.throws(() => checkDhParams(2, 2n ** 61n - 1n), /2048-bit/);
  assert.throws(() => checkDhParams(2, prime - 2n), /2048-bit|safe-prime/);
  assert.throws(() => checkDhParams(8 as unknown as number, prime), /g must be/);
  validateDhValue(2n ** 2047n, prime, 'test');
  assert.throws(() => validateDhValue(5n, prime, 'test'), /range/);
});

test('rsaPad: 256-byte output below the modulus (real server key)', async () => {
  const { TELEGRAM_RSA_KEYS } = await import('../src/crypto/rsa-keys.js');
  const key = TELEGRAM_RSA_KEYS[0];
  const data = secureRandom(80);
  const out = rsaPad(data, key);
  assert.equal(out.length, 256);
  assert.ok(bigFromBytesBE(out) < bigFromBytesBE(key.n));
});

test('rsaPad + rsaPadLegacy: full structural verification with a local RSA keypair', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const nBytes = Buffer.from(jwk.n, 'base64url');
  const eBytes = Buffer.from(jwk.e, 'base64url');
  const key: TelegramRsaKey = { fingerprint: 1n, n: nBytes, e: eBytes };
  const zeroIv = new Uint8Array(32);

  // --- RSA_PAD (2.0) ---
  const data = secureRandom(64);
  const padded = rsaPad(data, key);
  const m = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, padded);
  assert.equal(m.length, 256);
  const tempKeyXor = m.subarray(0, 32);
  const aes = m.subarray(32, 256);
  const tempKey = new Uint8Array(32);
  const shaAes = sha256(aes);
  for (let i = 0; i < 32; i++) tempKey[i] = tempKeyXor[i] ^ shaAes[i];
  const plain = ige256Decrypt(aes, tempKey, zeroIv);
  assert.equal(plain.length, 224);
  const dataPadReversed = plain.subarray(0, 192);
  const digest = plain.subarray(192, 224);
  const dataWithPadding = new Uint8Array(192);
  for (let i = 0; i < 192; i++) dataWithPadding[i] = dataPadReversed[191 - i];
  assert.deepEqual(digest, sha256(concat(tempKey, dataWithPadding)));
  assert.deepEqual(Buffer.from(dataWithPadding.subarray(0, data.length)), data, 'original data must be recoverable');

  // --- legacy (1.0) ---
  const legacy = rsaPadLegacy(data, key);
  const lm = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, legacy);
  const body = lm.subarray(lm.length - 255);
  assert.deepEqual(body.subarray(0, 20), sha1(data));
  assert.deepEqual(body.subarray(20, 20 + data.length), data);
});

test('SRP: independent server-side verification (doc formulas)', () => {
  const p = bigFromBytesBE(hexToBytes(KNOWN_PRIME_HEX));
  let g = 0;
  for (let cand = 2; cand <= 7; cand++) {
    try {
      checkDhParams(cand, p);
      g = cand;
      break;
    } catch {
      // try next
    }
  }
  assert.ok(g >= 2, 'no valid generator found for the known prime');

  const salt1 = secureRandom(16);
  const salt2 = secureRandom(16);
  const password = 'correct horse battery staple';
  const pw = Buffer.from(password, 'utf8');

  // server-side registration value v = g^PH2 (computed independently here)
  const ph1 = sha256(concat(salt2, sha256(concat(salt1, pw, salt1)), salt2));
  const dk = pbkdf2Sync(ph1, salt1, 100000, 64, 'sha512');
  const ph2 = sha256(concat(salt2, dk, salt2));
  const x = bigFromBytesBE(ph2);
  const v = modPow(BigInt(g), x, p);

  // server session
  const k = bigFromBytesBE(sha256(concat(be256(p), be256(BigInt(g)))));
  const bBytes = secureRandom(256);
  bBytes[0] |= 0x80;
  const b = bigFromBytesBE(bBytes);
  const gB = (k * v + modPow(BigInt(g), b, p)) % p;

  // client (the code under test)
  const check = computeSrpCheck(
    password,
    { g, p: bytesFromBigBE(p, 256), salt1, salt2 },
    { srpId: 77n, srpB: bytesFromBigBE(gB, 256) },
  );

  // server verifies M1 with its own math (doc formulas, independent path)
  const gA = bigFromBytesBE(check.A);
  const gABytes = be256(gA);
  const gBBytes = be256(gB);
  const u = bigFromBytesBE(sha256(concat(gABytes, gBBytes)));
  const sB = modPow((gA * modPow(v, u, p)) % p, b, p);
  const kB = sha256(be256(sB));
  const hp = sha256(bytesFromBigBE(p, 256));
  const hg = sha256(be256(BigInt(g)));
  const hpXorHg = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hpXorHg[i] = hp[i] ^ hg[i];
  const serverM1 = sha256(concat(hpXorHg, sha256(salt1), sha256(salt2), gABytes, gBBytes, kB));

  assert.equal(bytesToHex(check.M1), bytesToHex(serverM1), 'server must accept the client M1');
  assert.equal(check.srpId, 77n);
});
