/**
 * Number theory used by the handshake: pq factorization (Pollard rho) and
 * Miller-Rabin primality for dh_prime validation.
 *
 * @module
 */

import { secureRandom } from '../utils.js';

/** Greatest common divisor (non-negative inputs). */
export function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

let cachedPrimes: number[] | undefined;

/** All primes below 65536 (sieve, computed once). */
function smallPrimes(): number[] {
  if (cachedPrimes) return cachedPrimes;
  const limit = 65536;
  const sieve = new Uint8Array(limit).fill(1);
  sieve[0] = 0;
  sieve[1] = 0;
  for (let i = 2; i * i < limit; i++) {
    if (!sieve[i]) continue;
    for (let j = i * i; j < limit; j += i) sieve[j] = 0;
  }
  const primes: number[] = [];
  for (let i = 2; i < limit; i++) if (sieve[i]) primes.push(i);
  cachedPrimes = primes;
  return primes;
}

/** Pollard's rho (Floyd cycle, varied polynomial) for odd composite `n`. */
function pollardRho(n: bigint, maxSteps = 200_000): bigint {
  if (n % 2n === 0n) return 2n;
  for (let attempt = 0; attempt < 96; attempt++) {
    const c = BigInt(1 + attempt);
    let x = BigInt(3 + ((attempt * 37) % 512));
    let y = x;
    let d = 1n;
    let steps = 0;
    while (d === 1n) {
      if (++steps > maxSteps) break; // iteration cap: hostile input guard
      x = (x * x + c) % n;
      y = (y * y + c) % n;
      y = (y * y + c) % n;
      d = gcdBigInt(x > y ? x - y : y - x, n);
      if (x === y) break; // cycle without factor; retry with another polynomial
    }
    if (d !== 1n && d !== n) return d;
  }
  throw new Error(`pollardRho: failed to factor ${n}`);
}

/**
 * Factor `pq` (the 64-ish-bit product from `resPQ`) into its two odd primes
 * with `p < q`, as required by the handshake.
 */
export function factorizePQ(pq: bigint): { p: bigint; q: bigint } {
  if (pq < 15n || pq >= 2n ** 63n) {
    throw new RangeError(`pq out of range: ${pq}`);
  }
  // primality pre-check: a prime pq has no such factorization, and rho on a
  // prime would spin until the cap (a hostile server can send one pre-auth)
  if (isProbablyPrime(pq, 12)) {
    throw new Error(`pq is prime, cannot be a p*q product: ${pq}`);
  }
  const ordered = (a: bigint, b: bigint): { p: bigint; q: bigint } =>
    a < b ? { p: a, q: b } : { p: b, q: a };
  for (const prime of smallPrimes()) {
    const bp = BigInt(prime);
    if (pq % bp === 0n) return ordered(bp, pq / bp);
  }
  const d = pollardRho(pq);
  const { p, q } = ordered(d, pq / d);
  if (!isProbablyPrime(p, 12) || !isProbablyPrime(q, 12)) {
    throw new Error(`factorization did not yield two primes for pq=${pq}`);
  }
  return { p, q };
}

/** Miller-Rabin primality test; error probability < 4^-rounds. */
export function isProbablyPrime(n: bigint, rounds = 20): boolean {
  if (n < 2n) return false;
  if (n < 4n) return true;
  if (n % 2n === 0n) return false;
  let d = n - 1n;
  let s = 0n;
  while (d % 2n === 0n) {
    d >>= 1n;
    s += 1n;
  }
  const nMinus2 = n - 2n;
  for (let round = 0; round < rounds; round++) {
    // random base in [2, n-2]
    const bytes = secureRandom(Math.ceil(n.toString(16).length / 2));
    let a = BigInt('0x' + Buffer.from(bytes).toString('hex')) % nMinus2;
    if (a < 2n) a += 2n;
    let x = modPowLocal(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let i = 1n; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

function modPowLocal(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}
