#!/usr/bin/env node
/**
 * Extracts the Telegram server RSA public keys from teleproto's source
 * (byte-identical to the keys shipped by all clients) and emits
 * src/crypto/rsa-keys.ts. Also cross-checks the DH prime in dh.ts.
 *
 * Run: node scripts/extract-rsa-keys.mjs /path/to/teleproto-checkout
 *
 * The generated src/crypto/rsa-keys.ts is committed, so this script is only
 * needed to regenerate or re-verify it against a teleproto source checkout
 * (https://github.com/teleproto/teleproto).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const teleprotoRoot = process.argv[2];
if (!teleprotoRoot) {
  console.error('Usage: node scripts/extract-rsa-keys.mjs /path/to/teleproto-checkout');
  console.error('  regenerates src/crypto/rsa-keys.ts from teleproto and cross-checks the DH prime');
  process.exit(1);
}
const RSA_SRC = join(teleprotoRoot, 'teleproto/crypto/RSA.ts');
const DH_SRC = join(teleprotoRoot, 'teleproto/network/mtproto/authKeyExchange.ts');
const OUT = join(root, 'src/crypto/rsa-keys.ts');
const DH_LOCAL = join(root, 'src/crypto/dh.ts');

const rsaText = readFileSync(RSA_SRC, 'utf8');
const fingerprints = [...rsaText.matchAll(/fingerprint:\s*bigInt\("(-?\d+)"\)/g)].map((m) => m[1]);
const nBlocks = [...rsaText.matchAll(/n:\s*bigInt\(\s*([\s\S]*?)\s*\),/g)].map((m) => m[1]);
const exponents = [...rsaText.matchAll(/e:\s*(\d+)/g)].map((m) => m[1]);
if (fingerprints.length !== nBlocks.length || fingerprints.length !== exponents.length) {
  console.error(`parse mismatch: fingerprints=${fingerprints.length} n=${nBlocks.length} e=${exponents.length}`);
  process.exit(1);
}

const entries = [];
for (let i = 0; i < fingerprints.length; i++) {
  const digits = [...nBlocks[i].matchAll(/"(\d+)"/g)].map((m) => m[1]).join('');
  const n = BigInt(digits);
  if (n % 2n !== 1n) { console.error(`key ${i}: modulus is even`); process.exit(1); }
  if (!(n > 2n ** 2047n && n < 2n ** 2048n)) { console.error(`key ${i}: modulus is not 2048-bit`); process.exit(1); }
  const fp = BigInt(fingerprints[i]);
  // probe the fingerprint formula (informational)
  const nBytes = Buffer.from(n.toString(16).padStart(512, '0'), 'hex');
  const eBytes = Buffer.from(exponents[i].toString(16).padStart(6, '0'), 'hex');
  const tlString = (bytes) => {
    const len = bytes.length;
    const head = Buffer.from(len < 254 ? [len] : [0xfe, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff]);
    const pad = Buffer.alloc((4 - ((head.length + len) % 4)) % 4);
    return Buffer.concat([head, bytes, pad]);
  };
  const sha1 = (b) => createHash('sha1').update(b).digest();
  const candidates = {
    'sha1(tl(n)+tl(e)) last8-LE': () => BigInt('0x' + sha1(Buffer.concat([tlString(nBytes), tlString(eBytes)])).subarray(12, 20).toString('hex')),
    'sha1(tl(n)+tl(e)) last8-BE': () => BigInt('0x' + sha1(Buffer.concat([tlString(nBytes), tlString(eBytes)])).subarray(12, 20).reverse().toString('hex')),
  };
  let formula = 'unknown';
  for (const [name, fn] of Object.entries(candidates)) {
    if (fn() === BigInt.asUintN(64, fp)) formula = name;
  }
  console.log(`key ${i}: fingerprint=${fp} bits=2048 formula=${formula}`);
  entries.push({ fp, nHex: n.toString(16).padStart(512, '0'), eHex: BigInt(exponents[i]).toString(16).padStart(6, '0') });
}

const body = entries
  .map((e) => `  { fingerprint: ${e.fp}n, n: hexToBytes('${e.nHex}'), e: hexToBytes('${e.eHex}') },`)
  .join('\n');
writeFileSync(
  OUT,
  `// GENERATED FILE - DO NOT EDIT.\n` +
    `// Extracted from teleproto's crypto/RSA.ts by scripts/extract-rsa-keys.mjs\n` +
    `import type { TelegramRsaKey } from './rsa.js';\n` +
    `import { hexToBytes } from '../utils.js';\n\n` +
    `export const TELEGRAM_RSA_KEYS: readonly TelegramRsaKey[] = [\n${body}\n];\n`,
);
console.log(`wrote ${OUT} with ${entries.length} keys`);

// DH prime cross-check: teleproto's knownSafePrimes vs our dh.ts whitelist
const dhText = readFileSync(DH_SRC, 'utf8');
const block = dhText.slice(dhText.indexOf('knownSafePrimes'));
const teleProtoHex = [...block.matchAll(/"([0-9a-fA-F]{8,})"/g)].map((m) => m[1]).join('').toLowerCase();
const local = readFileSync(DH_LOCAL, 'utf8');
const localMatch = local.match(/'([0-9a-f]{400,})'/);
const localHex = localMatch ? localMatch[1] : '';
if (teleProtoHex.length !== 512 || localHex.length !== 512) {
  console.error(`DH prime length problem: teleproto=${teleProtoHex.length} local=${localHex.length}`);
  process.exit(1);
}
if (teleProtoHex === localHex) {
  console.log('DH-PRIME MATCH (dh.ts whitelist equals teleproto knownSafePrimes)');
} else {
  console.error('DH-PRIME MISMATCH');
  console.error(`  teleproto: ${teleProtoHex.slice(0, 64)}...${teleProtoHex.slice(-64)}`);
  console.error(`  local:     ${localHex.slice(0, 64)}...${localHex.slice(-64)}`);
  process.exit(1);
}
