/**
 * Diffie-Hellman parameter validation for the handshake: the published
 * 2048-bit safe prime, the g/p consistency rules (quadratic-residue
 * conditions), and the recommended range checks for g_a / g_b.
 *
 * @module
 */

import { bigFromBytesBE, hexToBytes } from '../utils.js';
import { isProbablyPrime } from './math.js';

/**
 * Known-good dh_prime values (big-endian hex, 256 bytes each), as published
 * on core.telegram.org/mtproto/auth_key. A prime found in this list skips
 * the slow full primality check; anything else is validated with
 * Miller-Rabin (see `checkDhParams`).
 */
const KNOWN_DH_PRIMES_HEX: readonly string[] = [
  'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b',
];
const KNOWN_DH_PRIMES: readonly bigint[] = KNOWN_DH_PRIMES_HEX.map((h) => bigFromBytesBE(hexToBytes(h)));

/**
 * Validate the server's `g` and `dh_prime`:
 *  - dh_prime must be a 2048-bit safe prime (both p and (p-1)/2 prime);
 *  - g must be in 2..7 and a quadratic residue mod dh_prime (checked with
 *    the simple congruence conditions from the MTProto spec);
 *  - primes found in the known list skip the Miller-Rabin work.
 */
export function checkDhParams(g: number, dhPrime: bigint): void {
  if (dhPrime <= 2n ** 2047n || dhPrime >= 2n ** 2048n) {
    throw new Error('dh_prime is not a 2048-bit prime');
  }
  if (!KNOWN_DH_PRIMES.includes(dhPrime)) {
    if (!(isProbablyPrime(dhPrime, 15) && isProbablyPrime((dhPrime - 1n) / 2n, 15))) {
      throw new Error('dh_prime failed the safe-prime check (not in the known list, and Miller-Rabin rejected it)');
    }
  }
  switch (g) {
    case 2:
      if (dhPrime % 8n !== 7n) throw new Error('for g=2, dh_prime mod 8 must be 7');
      break;
    case 3:
      if (dhPrime % 3n !== 2n) throw new Error('for g=3, dh_prime mod 3 must be 2');
      break;
    case 4:
      break;
    case 5: {
      const m = dhPrime % 5n;
      if (m !== 1n && m !== 4n) throw new Error('for g=5, dh_prime mod 5 must be 1 or 4');
      break;
    }
    case 6: {
      const m = dhPrime % 24n;
      if (m !== 19n && m !== 23n) throw new Error('for g=6, dh_prime mod 24 must be 19 or 23');
      break;
    }
    case 7: {
      const m = dhPrime % 7n;
      if (m !== 3n && m !== 5n && m !== 6n) throw new Error('for g=7, dh_prime mod 7 must be 3, 5 or 6');
      break;
    }
    default:
      throw new RangeError(`g must be one of 2..7, got ${g}`);
  }
}

/**
 * Validate a DH public value (g_a / g_b): the spec recommends checking
 * 2^{2048-64} < value < dh_prime - 2^{2048-64}.
 */
export function validateDhValue(value: bigint, dhPrime: bigint, name: string): void {
  if (value <= 0n) throw new Error(`invalid DH value ${name}: must be positive`);
  if (!(value > 2n ** 1984n && value < dhPrime - 2n ** 1984n)) {
    throw new Error(`invalid DH value ${name}: outside the recommended 2048-bit range`);
  }
}
