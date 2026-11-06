/**
 * Auth-key creation handshake (core.telegram.org/mtproto/auth_key):
 * req_pq_multi -> resPQ -> factor pq -> p_q_inner_data(_dc) via RSA_PAD ->
 * req_DH_params -> server_DH_params_ok -> (tmp AES from new_nonce) ->
 * server_DH_inner_data -> client_DH_inner_data -> set_client_DH_params ->
 * dh_gen_ok.
 *
 * Requires the core schema to be registered (importing the package root
 * does this); see src/index.ts.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { TLReader } from '../binary.js';
import { checkDhParams, validateDhValue } from '../crypto/dh.js';
import { factorizePQ } from '../crypto/math.js';
import { findRsaKey, rsaPad, rsaPadLegacy, type TelegramRsaKey } from '../crypto/rsa.js';
import { ige256Decrypt, ige256Encrypt } from '../crypto/ige.js';
import { bigFromBytesBE, bytesEqual, bytesFromBigBE, modPow, secureRandom } from '../utils.js';
import { parseTLObject, registry, serializeTLObject, tl, tlMethod } from '../tl/index.js';
import { packUnencryptedMessage, parseUnencryptedMessage } from './message.js';
import type { MTProtoSession } from './session.js';
import type { MTProtoConnection } from './connection.js';

/** Result of a successful handshake. */
export interface AuthKeyResult {
  /** 256-byte authorization key. */
  authKey: Uint8Array;
  /** Initial server salt. */
  serverSalt: bigint;
}

export interface CreateAuthKeyOptions {
  /** RSA padding mode; `auto` retries with the legacy scheme on -404. */
  rsaScheme?: 'auto' | 'new' | 'legacy';
  timeoutMs?: number;
}

/** Handshake failure. */
export class AuthKeyError extends Error {
  /** Server error code (-404 etc.) when the server rejected a request. */
  readonly serverCode: number | null;
  constructor(message: string, serverCode: number | null = null) {
    super(message);
    this.name = 'AuthKeyError';
    this.serverCode = serverCode;
  }
}

function sha1(bytes: Uint8Array): Buffer {
  return createHash('sha1').update(bytes).digest();
}

/** Best-effort zeroization of owned byte buffers (strings cannot be zeroed). */
function zeroize(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
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

/** Little-endian byte representation of a bigint (the on-wire form of int128/int256). */
function le(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Detect the int32 error codes the server sends in place of a body. */
function parseServerErrorCode(body: Uint8Array): number | null {
  if (body.length === 4) {
    const value = new TLReader(body).readInt();
    if (value < 0) return value;
  }
  return null;
}

/** Create an authorization key; updates the session (auth key, salt, time).
 * Restarts the handshake once when the server answers dh_gen_fail (per the
 * spec, that answer means the whole algorithm must be restarted). */
export async function createAuthKey(
  connection: MTProtoConnection,
  session: MTProtoSession,
  rsaKeys: readonly TelegramRsaKey[],
  options: CreateAuthKeyOptions = {},
): Promise<AuthKeyResult> {
  const scheme = options.rsaScheme ?? 'auto';
  if (scheme === 'auto') {
    try {
      return await runHandshakeWithRestart(connection, session, rsaKeys, 'new', options);
    } catch (err) {
      if (err instanceof AuthKeyError && err.serverCode === -404) {
        return await runHandshakeWithRestart(connection, session, rsaKeys, 'legacy', options);
      }
      throw err;
    }
  }
  return runHandshakeWithRestart(connection, session, rsaKeys, scheme === 'legacy' ? 'legacy' : 'new', options);
}

async function runHandshakeWithRestart(
  connection: MTProtoConnection,
  session: MTProtoSession,
  rsaKeys: readonly TelegramRsaKey[],
  rsaMode: 'new' | 'legacy',
  options: CreateAuthKeyOptions,
): Promise<AuthKeyResult> {
  try {
    return await runHandshake(connection, session, rsaKeys, rsaMode, options);
  } catch (err) {
    if (err instanceof AuthKeyError && /dh_gen_fail/.test(err.message)) {
      // dh_gen_fail: restart the algorithm from scratch (once)
      return await runHandshake(connection, session, rsaKeys, rsaMode, options);
    }
    throw err;
  }
}

async function runHandshake(
  connection: MTProtoConnection,
  session: MTProtoSession,
  rsaKeys: readonly TelegramRsaKey[],
  rsaMode: 'new' | 'legacy',
  options: CreateAuthKeyOptions,
): Promise<AuthKeyResult> {
  const timeoutMs = options.timeoutMs ?? 15000;

  const exchange = async (body: Uint8Array, what: string): Promise<Uint8Array> => {
    connection.send(packUnencryptedMessage(session, body));
    const payload = await connection.nextPayload(timeoutMs);
    const parsed = parseUnencryptedMessage(new TLReader(payload));
    const code = parseServerErrorCode(parsed.body);
    if (code !== null) {
      throw new AuthKeyError(`server rejected ${what}: ${code}`, code);
    }
    return parsed.body;
  };

  // --- 1) req_pq_multi -> resPQ -------------------------------------------
  const nonce = new TLReader(secureRandom(16)).readInt128();
  const resPqBody = await exchange(
    serializeTLObject(tlMethod('req_pq_multi', { nonce })).toBuffer(),
    'req_pq_multi',
  );
  const resPq = parseTLObject(new TLReader(resPqBody));
  if (resPq.name !== 'resPQ') throw new AuthKeyError(`expected resPQ, got ${resPq.name}`);
  if (resPq.args.nonce !== nonce) throw new AuthKeyError('resPQ nonce mismatch');
  const serverNonce = resPq.args.server_nonce as bigint;
  const pq = bigFromBytesBE(resPq.args.pq as Uint8Array);
  const { p, q } = factorizePQ(pq);

  const fingerprints = (resPq.args.server_public_key_fingerprints as bigint[]) ?? [];
  let rsaKey: TelegramRsaKey | undefined;
  for (const fp of fingerprints) {
    const found = findRsaKey(rsaKeys, fp);
    if (found) {
      rsaKey = found;
      break;
    }
  }
  if (!rsaKey) {
    throw new AuthKeyError(`no known server key for fingerprints: ${fingerprints.map((f) => f.toString()).join(', ')}`);
  }

  // --- 2) p_q_inner_data(_dc) + req_DH_params ------------------------------
  const newNonce = new TLReader(secureRandom(32)).readInt256();
  const innerName = registry.constructorByName('p_q_inner_data_dc') ? 'p_q_inner_data_dc' : 'p_q_inner_data';
  const innerArgs: Record<string, unknown> = {
    pq: bytesFromBigBE(pq),
    p: bytesFromBigBE(p),
    q: bytesFromBigBE(q),
    nonce,
    server_nonce: serverNonce,
    new_nonce: newNonce,
  };
  if (innerName === 'p_q_inner_data_dc') innerArgs.dc = connection.dcId;
  const innerData = serializeTLObject(tl(innerName, innerArgs)).toBuffer();
  const encryptedData = rsaMode === 'legacy' ? rsaPadLegacy(innerData, rsaKey) : rsaPad(innerData, rsaKey);

  const dhBody = await exchange(
    serializeTLObject(
      tlMethod('req_DH_params', {
        nonce,
        server_nonce: serverNonce,
        p: bytesFromBigBE(p),
        q: bytesFromBigBE(q),
        public_key_fingerprint: rsaKey.fingerprint,
        encrypted_data: encryptedData,
      }),
    ).toBuffer(),
    'req_DH_params',
  );
  const dhParams = parseTLObject(new TLReader(dhBody));
  if (dhParams.name === 'server_DH_params_fail') throw new AuthKeyError('server_DH_params_fail');
  if (dhParams.name !== 'server_DH_params_ok') throw new AuthKeyError(`expected server_DH_params_ok, got ${dhParams.name}`);
  if (dhParams.args.nonce !== nonce || dhParams.args.server_nonce !== serverNonce) {
    throw new AuthKeyError('server_DH_params nonce mismatch');
  }

  // --- tmp AES key/iv from new_nonce + server_nonce -------------------------
  const nn = le(newNonce, 32);
  const sn = le(serverNonce, 16);
  const sha1NnSn = sha1(concat(nn, sn));
  const sha1SnNn = sha1(concat(sn, nn));
  const sha1NnNn = sha1(concat(nn, nn));
  const tmpAesKey = concat(sha1NnSn, sha1SnNn.subarray(0, 12)); // 20 + 12
  const tmpAesIv = concat(sha1SnNn.subarray(12, 20), sha1NnNn, nn.subarray(0, 4)); // 8 + 20 + 4

  const encryptedAnswer = dhParams.args.encrypted_answer as Uint8Array;
  const plainAnswer = ige256Decrypt(encryptedAnswer, tmpAesKey, tmpAesIv);
  // answer_with_hash = SHA1(answer) + answer + padding; parse first to find the answer end
  const innerReader = new TLReader(plainAnswer.subarray(20));
  const inner = parseTLObject(innerReader);
  const answerBytes = plainAnswer.subarray(20, 20 + innerReader.pos);
  if (!bytesEqual(sha1(answerBytes).subarray(0, 20), plainAnswer.subarray(0, 20))) {
    throw new AuthKeyError('server_DH_inner_data hash mismatch');
  }
  if (inner.name !== 'server_DH_inner_data') throw new AuthKeyError(`expected server_DH_inner_data, got ${inner.name}`);
  if (inner.args.nonce !== nonce || inner.args.server_nonce !== serverNonce) {
    throw new AuthKeyError('server_DH_inner_data nonce mismatch');
  }
  const g = inner.args.g as number;
  const dhPrime = bigFromBytesBE(inner.args.dh_prime as Uint8Array);
  const gA = bigFromBytesBE(inner.args.g_a as Uint8Array);
  checkDhParams(g, dhPrime);
  validateDhValue(gA, dhPrime, 'g_a');
  session.applyServerTime(inner.args.server_time as number);

  // --- 3) client DH --------------------------------------------------------
  let retryId = 0n;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const bBytes = secureRandom(256);
    bBytes[0] = (bBytes[0] ?? 0) | 0x80;
    const b = bigFromBytesBE(bBytes);
    const gB = modPow(BigInt(g), b, dhPrime);
    const authKeyBig = modPow(gA, b, dhPrime);
    const authKeyBytes = bytesFromBigBE(authKeyBig, 256);
    const auxHash = sha1(authKeyBytes).subarray(0, 8); // 64 higher-order bits
    const clientInner = serializeTLObject(
      tl('client_DH_inner_data', {
        nonce,
        server_nonce: serverNonce,
        retry_id: retryId,
        g_b: bytesFromBigBE(gB, 256),
      }),
    ).toBuffer();
    const digest = sha1(clientInner);
    const padLen = (16 - ((20 + clientInner.length) % 16)) % 16;
    const withHash = concat(digest, clientInner, secureRandom(padLen));
    const encryptedClientData = ige256Encrypt(withHash, tmpAesKey, tmpAesIv);

    const answerBody = await exchange(
      serializeTLObject(
        tlMethod('set_client_DH_params', {
          nonce,
          server_nonce: serverNonce,
          encrypted_data: encryptedClientData,
        }),
      ).toBuffer(),
      `set_client_DH_params (attempt ${attempt})`,
    );
    const dhAnswer = parseTLObject(new TLReader(answerBody));

    if (dhAnswer.name === 'dh_gen_ok') {
      if (dhAnswer.args.nonce !== nonce || dhAnswer.args.server_nonce !== serverNonce) {
        throw new AuthKeyError('dh_gen_ok nonce mismatch');
      }
      // new_nonce_hash1 = last 16 bytes of SHA1(new_nonce || 0x01 || aux_hash[0..8])
      const hashInput = concat(nn, new Uint8Array([1]), auxHash);
      const expected = sha1(hashInput).subarray(4, 20);
      const got = le(dhAnswer.args.new_nonce_hash1 as bigint, 16);
      if (!bytesEqual(expected, got)) throw new AuthKeyError('dh_gen_ok: new_nonce_hash1 mismatch');

      const saltBytes = new Uint8Array(8);
      for (let i = 0; i < 8; i++) saltBytes[i] = nn[i]! ^ sn[i]!;
      const serverSalt = new TLReader(saltBytes).readLong();
      session.serverSalt = serverSalt;
      session.setAuthKey(authKeyBytes);
      zeroize(bBytes); // the private DH exponent is no longer needed
      return { authKey: authKeyBytes, serverSalt };
    }
    if (dhAnswer.name === 'dh_gen_retry') {
      retryId = new TLReader(auxHash).readLong();
      continue;
    }
    if (dhAnswer.name === 'dh_gen_fail') throw new AuthKeyError('dh_gen_fail: rejected');
    throw new AuthKeyError(`unexpected set_client_DH_params response: ${dhAnswer.name}`);
  }
  throw new AuthKeyError('too many dh_gen retries');
}
