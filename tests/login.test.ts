/**
 * Full login flow (phone code + 2FA SRP) over the ENCRYPTED RPC channel,
 * against a mock server that implements the server side of the protocol.
 * The mock verifies the client's SRP M1 with independent math (doc formulas).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, pbkdf2Sync, privateDecrypt, type KeyObject } from 'node:crypto';
import { Server as TcpServer, type Socket } from 'node:net';
import { createTransport } from '../src/mtproto/transports.js';
import { MTProtoSession } from '../src/mtproto/session.js';
import { parseUnencryptedMessage, parseEncryptedMessage } from '../src/mtproto/message.js';
import { ige256Decrypt, ige256Encrypt } from '../src/crypto/ige.js';
import type { TelegramRsaKey } from '../src/crypto/rsa.js';
import { TLReader, TLWriter } from '../src/binary.js';
import * as sdk from '../src/index.js';
import { TelegramClient } from '../src/client/telegram-client.js';
import { loginUser } from '../src/client/auth-flows.js';
import { bigFromBytesBE, bytesFromBigBE, bytesToHex, hexToBytes, modPow, secureRandom } from '../src/utils.js';

// Protocol constants declared INDEPENDENTLY of src/rpc.js (conformance:
// the mock must be allowed to disagree with the client under test).
const RPC_RESULT_ID = 0xf35c6d01; // rpc_result#f35c6d01 (core.tl)
const INVOKE_WITH_LAYER_ID = 0xda9b0d0d; // invokeWithLayer#da9b0d0d (api.tl)
const INIT_CONNECTION_ID = 0xc1cd5ea9; // initConnection#c1cd5ea9 (api.tl)

const KNOWN_PRIME_HEX =
  'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b';

const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();
const zero32 = new Uint8Array(32);
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
  for (let i = 0; i < 8; i++) v |= BigInt(d[12 + i]!) << BigInt(8 * i);
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

interface TwoFaState {
  v: bigint;
  b: bigint;
  gB: bigint;
  g: number;
  p: bigint;
  salt1: Uint8Array;
  salt2: Uint8Array;
}

class MockLoginServer {
  private server = new TcpServer();
  private sock: Socket | null = null;
  private transport = createTransport('intermediate');
  private lastMsgId = 0n;
  readonly rsaKey: TelegramRsaKey;
  private readonly privateKey: KeyObject;

  // handshake state
  private serverNonce: bigint | null = null;
  private newNonce: bigint | null = null;
  private a: bigint | null = null;
  private dhPrime: bigint | null = null;
  private pq: bigint | null = null;
  private authKeyBig: bigint | null = null;
  private authKeyBytes: Uint8Array | null = null;
  private authKeyId: bigint | null = null;
  private salt: bigint | null = null;

  // encrypted phase state
  clientSessionId: bigint | null = null;
  private serverSeq = 0;
  private twoFa: TwoFaState | null = null;
  private readonly password = 'secret123';
  m1Verified: boolean | null = null;
  /** When set, the next encrypted request is answered with bad_server_salt. */
  rotateSaltOnce: bigint | null = null;

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

  private sendPlain(body: Uint8Array): void {
    const w = new TLWriter();
    w.writeLong(0n);
    w.writeLong(this.serverMsgId());
    w.writeUint(body.length);
    w.writeRaw(body);
    this.sock?.write(this.transport.encode(w.toBuffer()));
  }

  private sendError(code: number): void {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(code, 0);
    this.sendPlain(buf);
  }

  private decryptRsa(enc: Uint8Array): { inner: sdk.TLObject; legacy: boolean } | null {
    const m = privateDecrypt({ key: this.privateKey, padding: constants.RSA_NO_PADDING }, enc);
    const tempKeyXor = m.subarray(0, 32);
    const aes = m.subarray(32, 256);
    const tempKey = new Uint8Array(32);
    const shaAes = sha256(aes);
    for (let i = 0; i < 32; i++) tempKey[i] = tempKeyXor[i]! ^ shaAes[i]!;
    const plain = ige256Decrypt(aes, tempKey, zero32);
    const dataPadReversed = plain.subarray(0, 192);
    const digest = plain.subarray(192, 224);
    const dataWithPadding = new Uint8Array(192);
    for (let i = 0; i < 192; i++) dataWithPadding[i] = dataPadReversed[191 - i]!;
    if (bytesToHex(digest) === bytesToHex(sha256(concat(tempKey, dataWithPadding)))) {
      try {
        const inner = sdk.parseTLObject(new TLReader(dataWithPadding));
        return { inner, legacy: false };
      } catch {
        // fall through to legacy
      }
    }
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
    if (!this.authKeyBytes) {
      this.handleHandshake(payload);
      return;
    }
    this.handleEncrypted(payload);
  }

  private handleHandshake(payload: Uint8Array): void {
    const { body } = parseUnencryptedMessage(new TLReader(payload));
    const obj = sdk.parseTLObject(new TLReader(body));
    if (obj.name === 'req_pq_multi') {
      const p = 2147483647n;
      const q = 2147483629n;
      this.pq = p * q;
      this.serverNonce = new TLReader(secureRandom(16)).readInt128();
      this.sendPlain(
        sdk
          .serializeTLObject(
            sdk.tl('resPQ', {
              nonce: obj.args.nonce as bigint,
              server_nonce: this.serverNonce,
              pq: bytesFromBigBE(this.pq),
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
      const decrypted = this.decryptRsa(obj.args.encrypted_data as Uint8Array);
      if (!decrypted) {
        this.sendError(-404);
        return;
      }
      const inner = decrypted.inner;
      const p = bigFromBytesBE(inner.args.p as Uint8Array);
      const q = bigFromBytesBE(inner.args.q as Uint8Array);
      if (p * q !== this.pq) throw new Error('p*q != pq');
      this.newNonce = inner.args.new_nonce as bigint;

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
      aBytes[0] = (aBytes[0] ?? 0) | 0x80;
      this.a = bigFromBytesBE(aBytes);
      this.dhPrime = dhPrime;
      const gA = modPow(BigInt(g), this.a, dhPrime);

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
      const ki = tmpKeyIv(this.newNonce, serverNonce);
      const encryptedAnswer = ige256Encrypt(withHash, ki.key, ki.iv);
      this.sendPlain(
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
      const ki = tmpKeyIv(this.newNonce!, serverNonce);
      const plain = ige256Decrypt(obj.args.encrypted_data as Uint8Array, ki.key, ki.iv);
      const inner = sdk.parseTLObject(new TLReader(plain.subarray(20)));
      const gB = bigFromBytesBE(inner.args.g_b as Uint8Array);
      this.authKeyBig = modPow(gB, this.a!, this.dhPrime!);
      this.authKeyBytes = bytesFromBigBE(this.authKeyBig, 256);
      const digest = sha1(this.authKeyBytes);
      const idBytes = digest.subarray(12, 20);
      let id = 0n;
      for (let i = 0; i < 8; i++) id |= BigInt(idBytes[i]!) << BigInt(8 * i);
      this.authKeyId = id;

      const nn = le(this.newNonce!, 32);
      const sn = le(this.serverNonce!, 16);
      const saltBytes = new Uint8Array(8);
      for (let i = 0; i < 8; i++) saltBytes[i] = nn[i]! ^ sn[i]!;
      this.salt = new TLReader(saltBytes).readLong();

      const auxHash = digest.subarray(0, 8);
      const hash1 = sha1(concat(nn, new Uint8Array([1]), auxHash)).subarray(4, 20);
      this.sendPlain(
        sdk
          .serializeTLObject(
            sdk.tl('dh_gen_ok', {
              nonce,
              server_nonce: serverNonce,
              new_nonce_hash1: new TLReader(hash1).readInt128(),
            }),
          )
          .toBuffer(),
      );
      return;
    }
    throw new Error(`mock: unexpected handshake request ${obj.name}`);
  }

  // -------------------------------------------------------------------
  // encrypted phase
  // -------------------------------------------------------------------

  private handleEncrypted(payload: Uint8Array): void {
    const msg = parseEncryptedMessage(
      {
        // a duck-typed session for the server-side parse
        authKey: this.authKeyBytes!,
        authKeyId: this.authKeyId!,
        sessionId: this.clientSessionId ?? 0n,
        serverSalt: this.salt ?? 0n,
        timeOffset: 0,
        nextMsgId: () => 0n,
        nextSeqNo: () => 0,
        now: () => 0,
        applyServerTime: () => undefined,
        setAuthKey: () => undefined,
      } as unknown as MTProtoSession,
      payload,
      0,
    );
    // conformance: a real server rejects epoch-1970 or non-mod-4 msg_ids
    assert.ok(msg.msgId % 4n === 0n, `client msg_id ${msg.msgId} must be divisible by 4`);
    const highBits = msg.msgId >> 32n;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const drift = highBits > nowSec ? highBits - nowSec : nowSec - highBits;
    assert.ok(drift < 60n, `client msg_id ${msg.msgId} does not approximate unixtime*2^32 (drift ${drift}s)`);
    if (this.clientSessionId === null) this.clientSessionId = msg.sessionId;

    // optional one-shot salt rotation: answer with bad_server_salt (a service
    // message, not an rpc_result) exactly like the real server does
    if (this.rotateSaltOnce !== null) {
      const newSalt = this.rotateSaltOnce;
      this.rotateSaltOnce = null;
      this.salt = newSalt; // the server packs replies with the new salt
      this.sendEncrypted(
        sdk
          .serializeTLObject(
            sdk.tl('bad_server_salt', {
              bad_msg_id: msg.msgId,
              bad_msg_seqno: msg.seqNo,
              error_code: 48,
              new_server_salt: newSalt,
            }),
          )
          .toBuffer(),
      );
      return;
    }

    // unwrap invokeWithLayer(initConnection(...)) exactly like the server
    const bodyReader = new TLReader(msg.body);
    let innerBody: Uint8Array = msg.body;
    const firstId = bodyReader.readUint();
    if (firstId === INVOKE_WITH_LAYER_ID) {
      bodyReader.readInt(); // layer
      const innerId = bodyReader.readUint();
      assert.equal(innerId, INIT_CONNECTION_ID, 'expected initConnection inside invokeWithLayer');
      bodyReader.readUint(); // flags
      bodyReader.readInt(); // api_id
      bodyReader.readString(); // device_model
      bodyReader.readString(); // system_version
      bodyReader.readString(); // app_version
      bodyReader.readString(); // system_lang_code
      bodyReader.readString(); // lang_pack
      bodyReader.readString(); // lang_code
      innerBody = msg.body.subarray(bodyReader.pos); // the bare inner query
    }

    const obj = sdk.parseTLObject(new TLReader(innerBody));
    const reqMsgId = msg.msgId;

    let result: sdk.TLObject;
    switch (obj.name) {
      case 'auth.sendCode':
        result = sdk.tl('auth.sentCode', {
          type: sdk.tl('auth.sentCodeTypeApp', { length: 5 }),
          phone_code_hash: 'mock-hash',
          timeout: 60,
        });
        break;
      case 'auth.signIn':
        result = sdk.tl('rpc_error', { error_code: 400, error_message: 'SESSION_PASSWORD_NEEDED' });
        break;
      case 'account.getPassword':
        this.setup2Fa();
        result = sdk.tl('account.password', {
          // real-server field layout: current_algo (flags.2) is paired with
          // srp_B and srp_id and is what login must use; new_algo (always
          // present, non-conditional) carries salts for SETTING a password
          current_algo: sdk.tl('passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow', {
            salt1: this.twoFa!.salt1,
            salt2: this.twoFa!.salt2,
            g: this.twoFa!.g,
            p: bytesFromBigBE(this.twoFa!.p, 256),
          }),
          new_algo: sdk.tl('passwordKdfAlgoUnknown', {}),
          new_secure_algo: sdk.tl('securePasswordKdfAlgoUnknown', {}),
          secure_random: new Uint8Array(32),
          srp_B: bytesFromBigBE(this.twoFa!.gB, 256),
          srp_id: 555n,
          hint: 'mock',
          has_password: true,
        });
        break;
      case 'auth.checkPassword': {
        const input = obj.args.password as sdk.TLObject;
        assert.equal(input.name, 'inputCheckPasswordSRP');
        const A = input.args.A as Uint8Array;
        const M1 = input.args.M1 as Uint8Array;
        const gA = bigFromBytesBE(A);
        const gB = this.twoFa!.gB;
        const u = bigFromBytesBE(sha256(concat(be256(gA), be256(gB))));
        const sB = modPow((gA * modPow(this.twoFa!.v, u, this.twoFa!.p)) % this.twoFa!.p, this.twoFa!.b, this.twoFa!.p);
        const kB = sha256(be256(sB));
        const hp = sha256(be256(this.twoFa!.p));
        const hg = sha256(be256(BigInt(this.twoFa!.g)));
        const hpXorHg = new Uint8Array(32);
        for (let i = 0; i < 32; i++) hpXorHg[i] = hp[i]! ^ hg[i]!;
        const serverM1 = sha256(
          concat(hpXorHg, sha256(this.twoFa!.salt1), sha256(this.twoFa!.salt2), be256(gA), be256(gB), kB),
        );
        this.m1Verified = bytesToHex(serverM1) === bytesToHex(M1);
        result = this.m1Verified
          ? sdk.tl('auth.authorization', {
              user: sdk.tl('user', {
                id: 10n,
                access_hash: 99n,
                first_name: 'Mock',
                username: 'mockuser',
              }),
            })
          : sdk.tl('rpc_error', { error_code: 400, error_message: 'PASSWORD_HASH_INVALID' });
        break;
      }
      case 'updates.getState':
        result = sdk.tl('updates.state', { pts: 1, qts: 2, date: 3, seq: 4, unread_count: 0 });
        break;
      case 'users.getUsers': {
        // Vector<User> result: exercises parseResult through the RPC path
        const w = new TLWriter();
        w.writeUint(RPC_RESULT_ID);
        w.writeLong(reqMsgId);
        w.writeUint(sdk.TL_VECTOR_ID);
        w.writeInt(2);
        sdk.serializeTLObject(sdk.tl('user', { id: 1n, access_hash: 11n, first_name: 'A', username: 'a' }), w);
        sdk.serializeTLObject(sdk.tl('user', { id: 2n, access_hash: 22n, first_name: 'B', username: 'b' }), w);
        this.sendEncrypted(w.toBuffer());
        return;
      }
      default:
        result = sdk.tl('rpc_error', { error_code: 500, error_message: `mock: ${obj.name} not implemented` });
    }

    const w = new TLWriter();
    w.writeUint(RPC_RESULT_ID);
    w.writeLong(reqMsgId);
    sdk.serializeTLObject(result, w);
    this.sendEncrypted(w.toBuffer());
  }

  private sendEncrypted(body: Uint8Array): void {
    // server->client packing (x = 8), mirrored by hand for the mock
    const w = new TLWriter();
    w.writeLong(this.salt!);
    w.writeLong(this.clientSessionId!);
    w.writeLong(this.serverMsgId());
    w.writeUint(this.serverSeq * 2 + 1);
    this.serverSeq += 1;
    w.writeUint(body.length);
    w.writeRaw(body);
    const fixed = 32 + body.length;
    let pad = 12;
    while ((fixed + pad) % 16 !== 0) pad += 1;
    w.writeRaw(secureRandom(pad));
    const plaintext = w.toBuffer();

    const key = this.authKeyBytes!;
    const msgKeyLarge = sha256(concat(key.subarray(96, 128), plaintext));
    const msgKey = msgKeyLarge.subarray(8, 24);
    const a = sha256(concat(msgKey, key.subarray(8, 44)));
    const b = sha256(concat(key.subarray(48, 84), msgKey));
    const aesKey = new Uint8Array(32);
    aesKey.set(a.subarray(0, 8), 0);
    aesKey.set(b.subarray(8, 24), 8);
    aesKey.set(a.subarray(24, 32), 24);
    const aesIv = new Uint8Array(32);
    aesIv.set(b.subarray(0, 8), 0);
    aesIv.set(a.subarray(8, 24), 8);
    aesIv.set(b.subarray(24, 32), 24);
    const encrypted = ige256Encrypt(plaintext, aesKey, aesIv);

    const out = new TLWriter();
    out.writeLong(this.authKeyId!);
    out.writeRaw(msgKey);
    out.writeRaw(encrypted);
    this.sock?.write(this.transport.encode(out.toBuffer()));
  }

  private setup2Fa(): void {
    if (this.twoFa) return;
    const p = bigFromBytesBE(hexToBytes(KNOWN_PRIME_HEX));
    let g = 0;
    for (let cand = 2; cand <= 7; cand++) {
      try {
        sdk.checkDhParams(cand, p);
        g = cand;
        break;
      } catch {
        // try next
      }
    }
    assert.ok(g >= 2);
    const salt1 = secureRandom(16);
    const salt2 = secureRandom(16);
    const pw = Buffer.from(this.password, 'utf8');
    const ph1 = sha256(concat(salt2, sha256(concat(salt1, pw, salt1)), salt2));
    const dk = pbkdf2Sync(ph1, salt1, 100000, 64, 'sha512');
    const ph2 = sha256(concat(salt2, dk, salt2));
    const x = bigFromBytesBE(ph2);
    const v = modPow(BigInt(g), x, p);
    const k = bigFromBytesBE(sha256(concat(be256(p), be256(BigInt(g)))));
    const bBytes = secureRandom(256);
    bBytes[0] = (bBytes[0] ?? 0) | 0x80;
    const b = bigFromBytesBE(bBytes);
    const gB = (k * v + modPow(BigInt(g), b, p)) % p;
    this.twoFa = { v, b, gB, g, p, salt1, salt2 };
  }
}

test('login flow over encrypted RPC (incl. 2FA SRP) against a mock server', async () => {
  const mock = new MockLoginServer();
  const port = await mock.start();
  const client = new TelegramClient({
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    host: '127.0.0.1',
    port,
    dcId: 2,
  });
  try {
    await client.connect([mock.rsaKey]);
    // parseEncryptedMessage strictly enforces session_id on every message, so
    // the mock must know the client's session id before the first RPC arrives
    // (a real server learns it from the session-creation flow).
    mock.clientSessionId = client.session.sessionId;

    const user = await loginUser(client, {
      phone: async () => '+1234567890',
      code: async () => '424242',
      password: async () => 'secret123',
    });

    assert.equal(user.name, 'user');
    assert.equal(user.args.username, 'mockuser');
    assert.equal(user.args.first_name, 'Mock');
    assert.equal(user.args.id, 10n);
    assert.equal(client.me, user);
    assert.equal(mock.m1Verified, true, 'the mock server must accept the client SRP M1');
    // the entity cache picked up the access hash from the user object
    const cached = client.entityCache.resolve('mockuser');
    assert.ok(cached);
    assert.equal(cached.accessHash, 99n);
  } finally {
    await client.disconnect();
    mock.stop();
  }
});

test('bad_server_salt: the invoker adopts the new salt and transparently resends', async () => {
  const mock = new MockLoginServer();
  mock.rotateSaltOnce = 0x0123456789abcdefn;
  const port = await mock.start();
  const client = new TelegramClient({
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    host: '127.0.0.1',
    port,
    dcId: 2,
  });
  try {
    await client.connect([mock.rsaKey]);
    mock.clientSessionId = client.session.sessionId;

    // the first attempt is answered with bad_server_salt; the invoker must
    // adopt the rotated salt and resend, and the SECOND attempt must succeed
    const result = (await client.invoke(sdk.tlMethod('updates.getState', {}))) as sdk.TLObject;
    assert.equal(result.name, 'updates.state', 'the transparently resent request must succeed');
    assert.equal(client.session.serverSalt, 0x0123456789abcdefn, 'the rotated salt must be in effect');
  } finally {
    await client.disconnect();
    mock.stop();
  }
});

test('Vector results are parsed through the RPC path (users.getUsers)', async () => {
  const mock = new MockLoginServer();
  const port = await mock.start();
  const client = new TelegramClient({
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    host: '127.0.0.1',
    port,
    dcId: 2,
  });
  try {
    await client.connect([mock.rsaKey]);
    mock.clientSessionId = client.session.sessionId;
    const users = await client.invoke(sdk.tlMethod('users.getUsers', { id: [] }));
    assert.ok(Array.isArray(users), 'a Vector result must resolve to an array');
    const list = users as sdk.TLObject[];
    assert.equal(list.length, 2);
    assert.equal(list[0]!.name, 'user');
    assert.equal(list[1]!.args.username, 'b');
  } finally {
    await client.disconnect();
    mock.stop();
  }
});

test('session export/apply round-trip preserves the logged-in user', async () => {
  const { exportSessionString } = await import('../src/client/session-store.js');
  const mock = new MockLoginServer();
  const port = await mock.start();
  const client = new TelegramClient({
    apiId: 12345,
    apiHash: '0123456789abcdef0123456789abcdef',
    host: '127.0.0.1',
    port,
    dcId: 2,
  });
  try {
    await client.connect([mock.rsaKey]);
    mock.clientSessionId = client.session.sessionId;
    const me = await loginUser(client, {
      phone: async () => '+1234567890',
      code: async () => '424242',
      password: async () => 'secret123',
    });

    const string = exportSessionString(client);
    const restored = new TelegramClient({
      apiId: 12345,
      apiHash: '0123456789abcdef0123456789abcdef',
      session: string,
    });
    assert.ok(restored.session.authKey);
    assert.deepEqual(Buffer.from(restored.session.authKey!), Buffer.from(client.session.authKey!));
    assert.equal(restored.session.serverSalt, client.session.serverSalt);
    // the logged-in user survives the round-trip: resumed clients skip re-login
    assert.ok(restored.me, 'client.me must be restored from the session');
    assert.equal(restored.me!.name, 'user');
    assert.equal(restored.me!.args.id, (me.args.id as bigint));
    assert.equal(restored.me!.args.username, 'mockuser');
    // and the restored user is usable as a peer
    const cached = restored.entityCache.resolve('mockuser');
    assert.ok(cached);
    assert.equal(cached.accessHash, 99n);
  } finally {
    await client.disconnect();
    mock.stop();
  }
});
