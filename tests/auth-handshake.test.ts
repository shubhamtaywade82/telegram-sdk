/**
 * Full auth-key handshake against an in-process mock server that implements
 * the SERVER side of the protocol (own RSA keypair, DH, dh_gen_ok), over a
 * real TCP socket with the intermediate transport. Includes the RSA
 * new/legacy scheme negotiation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto';
import { Server as TcpServer, type Socket } from 'node:net';
import { createTransport } from '../src/mtproto/transports.js';
import { MTProtoConnection } from '../src/mtproto/connection.js';
import { MTProtoSession } from '../src/mtproto/session.js';
import { createAuthKey, AuthKeyError } from '../src/mtproto/auth-key.js';
import { parseUnencryptedMessage } from '../src/mtproto/message.js';
import { ige256Decrypt, ige256Encrypt } from '../src/crypto/ige.js';
import type { TelegramRsaKey } from '../src/crypto/rsa.js';
import { TLReader, TLWriter } from '../src/binary.js';
import * as sdk from '../src/index.js';
import { bigFromBytesBE, bytesFromBigBE, bytesToHex, hexToBytes, modPow, secureRandom } from '../src/utils.js';

const KNOWN_PRIME_HEX =
  'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b';

const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();
const zero32 = new Uint8Array(32);

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

function le(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function tlStr(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  const head = Buffer.from(len < 254 ? [len] : [0xfe, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff]);
  const pad = (4 - ((head.length + len) % 4)) % 4;
  return concat(head, bytes, new Uint8Array(pad));
}

function fingerprintOf(nBytes: Uint8Array, eBytes: Uint8Array): bigint {
  const d = sha1(concat(tlStr(nBytes), tlStr(eBytes)));
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(d[12 + i]) << BigInt(8 * i);
  return BigInt.asIntN(64, v);
}

function tmpKeyIv(newNonce: bigint, serverNonce: bigint): { key: Uint8Array; iv: Uint8Array } {
  const nn = le(newNonce, 32);
  const sn = le(serverNonce, 16);
  const sha1NnSn = sha1(concat(nn, sn));
  const sha1SnNn = sha1(concat(sn, nn));
  const sha1NnNn = sha1(concat(nn, nn));
  const key = concat(sha1NnSn, sha1SnNn.subarray(0, 12));
  const iv = concat(sha1SnNn.subarray(12, 20), sha1NnNn, nn.subarray(0, 4));
  return { key, iv };
}

class MockHandshakeServer {
  private server = new TcpServer();
  private sock: Socket | null = null;
  private transport = createTransport('intermediate');
  private lastMsgId = 0n;
  readonly rsaKey: TelegramRsaKey;
  private readonly privateKey: KeyObject;
  mode: 'any' | 'legacy-only' = 'any';
  usedLegacy = false;
  state: {
    serverNonce: bigint | null;
    newNonce: bigint | null;
    a: bigint | null;
    dhPrime: bigint | null;
    g: number;
    authKey: bigint | null;
    pq: bigint | null;
  } = { serverNonce: null, newNonce: null, a: null, dhPrime: null, g: 0, authKey: null, pq: null };

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const nBytes = new Uint8Array(Buffer.from(jwk.n, 'base64url'));
    const eBytes = new Uint8Array(Buffer.from(jwk.e, 'base64url'));
    this.rsaKey = { fingerprint: fingerprintOf(nBytes, eBytes), n: nBytes, e: eBytes };
    this.privateKey = privateKey;
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        assert.ok(address && typeof address === 'object');
        resolve(address.port);
      });
      this.server.on('connection', (sock) => {
        this.sock = sock;
        sock.setNoDelay(true);
        this.transport = createTransport('intermediate');
        // real servers never send a hello; skip the client's 4-byte hello
        let helloSkipped = false;
        sock.on('data', (chunk) => {
          try {
            let buf: Uint8Array = chunk;
            if (!helloSkipped) {
              helloSkipped = true;
              buf = chunk.subarray(4);
            }
            for (const payload of this.transport.feed(buf)) this.handle(payload);
          } catch (err) {
            sock.destroy();
            throw err;
          }
        });
      });
    });
  }

  stop(): void {
    this.sock?.destroy();
    this.server.close();
  }

  private serverMsgId(): bigint {
    const now = Math.floor(Date.now() / 1000);
    let id = (BigInt(now) << 32n) | BigInt(secureRandom(4).readUInt32BE(0) & 0xfffffffc);
    if (id <= this.lastMsgId) id = this.lastMsgId + 4n;
    this.lastMsgId = id;
    return id + 1n; // server responses: mod 4 == 1
  }

  private send(body: Uint8Array): void {
    const w = new TLWriter();
    w.writeLong(0n); // auth_key_id
    w.writeLong(this.serverMsgId());
    w.writeUint(body.length);
    w.writeRaw(body);
    this.sock?.write(this.transport.encode(w.toBuffer()));
  }

  private sendError(code: number): void {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(code, 0);
    this.send(buf);
  }

  private decryptRsa(enc: Uint8Array): { inner: sdk.TLObject; legacy: boolean } | null {
    const m = privateDecrypt({ key: this.privateKey, padding: constants.RSA_NO_PADDING }, enc);
    // new scheme
    const tempKeyXor = m.subarray(0, 32);
    const aes = m.subarray(32, 256);
    const tempKey = new Uint8Array(32);
    const shaAes = sha256(aes);
    for (let i = 0; i < 32; i++) tempKey[i] = tempKeyXor[i] ^ shaAes[i];
    const plain = ige256Decrypt(aes, tempKey, zero32);
    const dataPadReversed = plain.subarray(0, 192);
    const digest = plain.subarray(192, 224);
    const dataWithPadding = new Uint8Array(192);
    for (let i = 0; i < 192; i++) dataWithPadding[i] = dataPadReversed[191 - i];
    if (bytesToHex(digest) === bytesToHex(sha256(concat(tempKey, dataWithPadding)))) {
      try {
        const inner = sdk.parseTLObject(new TLReader(dataWithPadding));
        return { inner, legacy: false };
      } catch {
        // fall through to legacy
      }
    }
    // legacy scheme
    const body = m.subarray(m.length - 255);
    try {
      const inner = sdk.parseTLObject(new TLReader(body.subarray(20)));
      const dataLen = sdk.serializeTLObject(inner).byteLength;
      if (bytesToHex(body.subarray(0, 20)) === bytesToHex(sha1(body.subarray(20, 20 + dataLen)))) {
        return { inner, legacy: true };
      }
    } catch {
      // not legacy either
    }
    return null;
  }

  private handle(payload: Uint8Array): void {
    const { body } = parseUnencryptedMessage(new TLReader(payload));
    if (body.length === 4) {
      const code = new TLReader(body).readInt();
      if (code < 0) throw new Error(`mock server received error ${code}`);
    }
    const obj = sdk.parseTLObject(new TLReader(body));
    if (obj.name === 'req_pq_multi') {
      const p = 2147483647n;
      const q = 2147483629n;
      this.state.pq = p * q;
      this.state.serverNonce = new TLReader(secureRandom(16)).readInt128();
      this.send(
        sdk
          .serializeTLObject(
            sdk.tl('resPQ', {
              nonce: obj.args.nonce as bigint,
              server_nonce: this.state.serverNonce,
              pq: bytesFromBigBE(this.state.pq),
              server_public_key_fingerprints: [this.rsaKey.fingerprint],
            }),
          )
          .toBuffer(),
      );
      return;
    }
    if (obj.name === 'req_DH_params') {
      const nonce = obj.args.nonce as bigint;
      const serverNonce = obj.args.server_nonce as bigint;
      if (serverNonce !== (this.state.serverNonce ?? serverNonce)) throw new Error('server_nonce mismatch');
      const decrypted = this.decryptRsa(obj.args.encrypted_data as Uint8Array);
      if (!decrypted) {
        this.sendError(-404);
        return;
      }
      if (this.mode === 'legacy-only' && !decrypted.legacy) {
        this.sendError(-404);
        return;
      }
      this.usedLegacy = decrypted.legacy;
      const inner = decrypted.inner;
      if (!inner.name.startsWith('p_q_inner_data')) throw new Error(`unexpected inner ${inner.name}`);
      const p = bigFromBytesBE(inner.args.p as Uint8Array);
      const q = bigFromBytesBE(inner.args.q as Uint8Array);
      if (p * q !== this.state.pq) throw new Error('p*q != pq');
      this.state.newNonce = inner.args.new_nonce as bigint;

      const dhPrime = bigFromBytesBE(hexToBytes(KNOWN_PRIME_HEX));
      let g = 0;
      for (let cand = 2; cand <= 7; cand++) {
        try {
          sdk.checkDhParams(cand, dhPrime);
          g = cand;
          break;
        } catch {
          // try next generator
        }
      }
      assert.ok(g >= 2, 'mock could not pick a generator');
      const aBytes = secureRandom(256);
      aBytes[0] |= 0x80;
      this.state.a = bigFromBytesBE(aBytes);
      this.state.dhPrime = dhPrime;
      this.state.g = g;
      const gA = modPow(BigInt(g), this.state.a, dhPrime);

      const answer = sdk
        .serializeTLObject(
          sdk.tl('server_DH_inner_data', {
            nonce,
            server_nonce: serverNonce,
            g,
            dh_prime: bytesFromBigBE(dhPrime, 256),
            g_a: bytesFromBigBE(gA, 256),
            server_time: Math.floor(Date.now() / 1000),
          }),
        )
        .toBuffer();
      const withHash = concat(sha1(answer), answer, secureRandom((16 - ((20 + answer.length) % 16)) % 16));
      const { key, iv } = tmpKeyIv(this.state.newNonce, serverNonce);
      const encryptedAnswer = ige256Encrypt(withHash, key, iv);
      this.send(
        sdk
          .serializeTLObject(
            sdk.tl('server_DH_params_ok', {
              nonce,
              server_nonce: serverNonce,
              encrypted_answer: encryptedAnswer,
            }),
          )
          .toBuffer(),
      );
      return;
    }
    if (obj.name === 'set_client_DH_params') {
      const nonce = obj.args.nonce as bigint;
      const serverNonce = obj.args.server_nonce as bigint;
      const { key, iv } = tmpKeyIv(this.state.newNonce!, serverNonce);
      const plain = ige256Decrypt(obj.args.encrypted_data as Uint8Array, key, iv);
      const inner = sdk.parseTLObject(new TLReader(plain.subarray(20)));
      if (inner.name !== 'client_DH_inner_data') throw new Error(`unexpected ${inner.name}`);
      const gB = bigFromBytesBE(inner.args.g_b as Uint8Array);
      const authKey = modPow(gB, this.state.a!, this.state.dhPrime!);
      this.state.authKey = authKey;

      const auxHash = sha1(bytesFromBigBE(authKey, 256)).subarray(0, 8);
      const nn = le(this.state.newNonce!, 32);
      const hash1 = sha1(concat(nn, new Uint8Array([1]), auxHash)).subarray(4, 20);
      const hash1Value = new TLReader(hash1).readInt128();
      this.send(
        sdk
          .serializeTLObject(
            sdk.tl('dh_gen_ok', {
              nonce,
              server_nonce: serverNonce,
              new_nonce_hash1: hash1Value,
            }),
          )
          .toBuffer(),
      );
      return;
    }
    throw new Error(`mock server: unexpected request ${obj.name}`);
  }
}

test('full handshake against a mock server (new RSA scheme)', async () => {
  const mock = new MockHandshakeServer();
  const port = await mock.start();
  const conn = new MTProtoConnection({ host: '127.0.0.1', port, dcId: 2, transport: 'intermediate' });
  const session = new MTProtoSession();
  try {
    await conn.connect();
    const result = await createAuthKey(conn, session, [mock.rsaKey], { rsaScheme: 'new' });
    assert.ok(mock.state.authKey, 'server must have computed its auth key');
    assert.equal(
      bytesToHex(result.authKey),
      bytesToHex(bytesFromBigBE(mock.state.authKey, 256)),
      'client and server keys must match',
    );
    assert.equal(result.authKey.length, 256);
    assert.ok(session.authKey, 'session must hold the key');

    // independent salt check
    const nn = le(mock.state.newNonce!, 32);
    const sn = le(mock.state.serverNonce!, 16);
    const salt = new Uint8Array(8);
    for (let i = 0; i < 8; i++) salt[i] = nn[i] ^ sn[i];
    assert.equal(result.serverSalt, new TLReader(salt).readLong());
  } finally {
    conn.close();
    mock.stop();
  }
});

test('auto mode falls back to legacy RSA when the server rejects the new scheme', async () => {
  const mock = new MockHandshakeServer();
  mock.mode = 'legacy-only';
  const port = await mock.start();
  const conn = new MTProtoConnection({ host: '127.0.0.1', port, dcId: 2, transport: 'intermediate' });
  const session = new MTProtoSession();
  try {
    await conn.connect();
    const result = await createAuthKey(conn, session, [mock.rsaKey], { rsaScheme: 'auto' });
    assert.equal(mock.usedLegacy, true, 'second attempt must have used the legacy scheme');
    assert.equal(bytesToHex(result.authKey), bytesToHex(bytesFromBigBE(mock.state.authKey!, 256)));
  } finally {
    conn.close();
    mock.stop();
  }
});

test('unknown server fingerprint fails with a clear error', async () => {
  const mock = new MockHandshakeServer();
  const port = await mock.start();
  const other = new MockHandshakeServer(); // different keypair
  const conn = new MTProtoConnection({ host: '127.0.0.1', port, dcId: 2, transport: 'intermediate' });
  const session = new MTProtoSession();
  try {
    await conn.connect();
    await assert.rejects(
      () => createAuthKey(conn, session, [other.rsaKey], { rsaScheme: 'new' }),
      (err: unknown) => err instanceof AuthKeyError && /no known server key/.test(err.message),
    );
  } finally {
    conn.close();
    mock.stop();
    other.stop();
  }
});
