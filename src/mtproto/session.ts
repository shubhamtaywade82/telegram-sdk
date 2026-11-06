/**
 * MTProto session state: authorization key, session id, server salt,
 * time offset, and the msg_id / seq_no generators.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { randomLong } from '../utils.js';

/** Session state for one client-server connection. */
export class MTProtoSession {
  /** 256-byte authorization key (null before the handshake). */
  authKey: Uint8Array | null = null;
  /** 64-bit key identifier; 0n while unauthorized. */
  authKeyId: bigint = 0n;
  /** Random per-connection session id. */
  sessionId: bigint = randomLong();
  /** Current server salt. */
  serverSalt: bigint = 0n;
  /** serverTime - localTime in seconds. */
  timeOffset = 0;

  private lastMsgId = 0n;
  private seqCounter = 0;

  /** Install (or clear) the authorization key. */
  setAuthKey(key: Uint8Array | null): void {
    if (key === null) {
      this.authKey = null;
      this.authKeyId = 0n;
      return;
    }
    if (key.length !== 256) throw new RangeError(`auth key must be 256 bytes, got ${key.length}`);
    this.authKey = key;
    // auth_key_id = the 64 lower-order bits of SHA1(auth_key), stored so
    // that its little-endian serialization equals those 8 bytes.
    const digest = createHash('sha1').update(key).digest();
    this.authKeyId = digest.subarray(12, 20).readBigUInt64LE(0);
  }

  /** Server-aligned unix seconds. */
  now(): number {
    return Math.floor(Date.now() / 1000) + this.timeOffset;
  }

  /** Apply a server timestamp (from server_DH_inner_data / bad_server_salt). */
  applyServerTime(serverTime: number): void {
    const local = Math.floor(Date.now() / 1000);
    const offset = serverTime - local;
    // only meaningful shifts are applied; keeps msg_id monotonic
    if (Math.abs(offset) >= 1) this.timeOffset = offset;
  }

  /**
   * Next client msg_id: approximately unixtime * 2^32, divisible by 4,
   * strictly monotonic. The lower 32 bits encode the fractional part of
   * the current time (replay protection).
   */
  nextMsgId(): bigint {
    const nowMs = (Date.now() + this.timeOffset * 1000) / 1000;
    const seconds = Math.floor(nowMs);
    const fraction = nowMs - seconds;
    // `>>> 0` is essential: the & coercion is int32-signed, so without the
    // unsigned shift every fraction >= 0.5 wraps negative and the assembled
    // msg_id collapses to epoch-1970 values.
    let low = (Math.floor(fraction * 0x100000000) & 0xfffffffc) >>> 0;
    if (low === 0) low = 4;
    let msgId = (BigInt(seconds) << 32n) | BigInt(low);
    if (msgId <= this.lastMsgId) msgId = this.lastMsgId + 4n;
    if (msgId % 4n !== 0n) msgId += 4n - (msgId % 4n);
    this.lastMsgId = msgId;
    return msgId;
  }

  /**
   * Next seq_no: content-related messages are odd and increment the
   * counter; non-content messages are even and do not.
   */
  nextSeqNo(content: boolean): number {
    if (content) {
      const value = this.seqCounter * 2 + 1;
      this.seqCounter += 1;
      return value;
    }
    return this.seqCounter * 2;
  }
}
