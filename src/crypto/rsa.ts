/**
 * Telegram RSA helpers: the `RSA_PAD` construction used during the
 * auth-key handshake (core.telegram.org/mtproto/auth_key, section 4.1) and
 * the server-key lookup interface. The legacy MTProto 1.0 RSA padding is
 * also provided as a fallback; production servers accept both.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { bigFromBytesBE, bytesFromBigBE, modPow, secureRandom } from '../utils.js';
import { ige256Encrypt } from './ige.js';

/** A Telegram server RSA public key (as distributed with official clients). */
export interface TelegramRsaKey {
  /** 64-bit fingerprint as sent by the server in `resPQ`. */
  readonly fingerprint: bigint;
  /** RSA modulus, big-endian bytes (256 bytes for the production keys). */
  readonly n: Uint8Array;
  /** RSA public exponent, big-endian bytes. */
  readonly e: Uint8Array;
}

/** Find a loaded server key by fingerprint (signed/unsigned representations both accepted). */
export function findRsaKey(keys: readonly TelegramRsaKey[], fingerprint: bigint): TelegramRsaKey | undefined {
  const norm = BigInt.asUintN(64, fingerprint);
  return keys.find((k) => BigInt.asUintN(64, k.fingerprint) === norm);
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

/**
 * `RSA_PAD(data, server_public_key)` - MTProto 2.0 construction:
 *  - data_with_padding := data + random padding (exactly 192 bytes)
 *  - data_pad_reversed := data_with_padding reversed
 *  - temp_key := 32 random bytes
 *  - data_with_hash := data_pad_reversed + SHA256(temp_key + data_with_padding) (224 bytes)
 *  - aes_encrypted := AES256-IGE(data_with_hash, temp_key, zero IV)
 *  - temp_key_xor := temp_key XOR SHA256(aes_encrypted)
 *  - key_aes_encrypted := temp_key_xor + aes_encrypted (256 bytes)
 *  - retry with a fresh temp_key while key_aes_encrypted >= modulus
 *  - result := key_aes_encrypted ^ e (mod n), big-endian, modulus-length bytes
 */
export function rsaPad(data: Uint8Array, key: TelegramRsaKey): Uint8Array {
  if (data.length === 0 || data.length > 144) {
    throw new RangeError(`RSA_PAD payload must be 1..144 bytes, got ${data.length}`);
  }
  const modulus = bigFromBytesBE(key.n);
  const exponent = bigFromBytesBE(key.e);
  const zeroIv = new Uint8Array(32);
  for (let attempt = 0; attempt < 128; attempt++) {
    const dataWithPadding = new Uint8Array(192);
    dataWithPadding.set(data, 0);
    dataWithPadding.set(secureRandom(192 - data.length), data.length);

    const dataPadReversed = new Uint8Array(192);
    for (let i = 0; i < 192; i++) dataPadReversed[i] = dataWithPadding[191 - i];

    const tempKey = secureRandom(32);
    const hashInput = new Uint8Array(32 + 192);
    hashInput.set(tempKey, 0);
    hashInput.set(dataWithPadding, 32);
    const digest = sha256(hashInput);

    const dataWithHash = new Uint8Array(224);
    dataWithHash.set(dataPadReversed, 0);
    dataWithHash.set(digest, 192);

    const aesEncrypted = ige256Encrypt(dataWithHash, tempKey, zeroIv);
    const shaAes = sha256(aesEncrypted);
    const tempKeyXor = new Uint8Array(32);
    for (let i = 0; i < 32; i++) tempKeyXor[i] = tempKey[i] ^ shaAes[i];

    const keyAesEncrypted = new Uint8Array(256);
    keyAesEncrypted.set(tempKeyXor, 0);
    keyAesEncrypted.set(aesEncrypted, 32);

    const value = bigFromBytesBE(keyAesEncrypted);
    if (value >= modulus) continue; // extremely rare; retry with a fresh temp_key
    return bytesFromBigBE(modPow(value, exponent, modulus), key.n.length);
  }
  throw new Error('rsaPad: failed to produce a value below the RSA modulus after 128 attempts');
}

/**
 * Legacy MTProto 1.0 RSA encryption, still accepted by servers:
 * `SHA1(data) + data + random padding` to 255 bytes, RSA as a big-endian
 * 256-byte (modulus-length) integer.
 */
export function rsaPadLegacy(data: Uint8Array, key: TelegramRsaKey): Uint8Array {
  if (data.length === 0 || data.length > 144) {
    throw new RangeError(`RSA payload must be 1..144 bytes, got ${data.length}`);
  }
  const modulus = bigFromBytesBE(key.n);
  const exponent = bigFromBytesBE(key.e);
  const digest = createHash('sha1').update(data).digest();
  const payload = new Uint8Array(255);
  payload.set(digest, 0);
  payload.set(data, digest.length);
  payload.set(secureRandom(255 - digest.length - data.length), digest.length + data.length);
  return bytesFromBigBE(modPow(bigFromBytesBE(payload), exponent, modulus), key.n.length);
}
