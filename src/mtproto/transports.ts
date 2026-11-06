/**
 * TCP transport framing for MTProto: `abridged`, `intermediate` and `full`.
 *
 *  - abridged:     hello byte 0xef; packets are quarter-word lengths
 *                  (1 byte, or 0x7f + 3-byte LE when >= 0x7f).
 *  - intermediate: hello 0xeeeeeeee; packets are 4-byte LE length + payload.
 *                  A negative length signals a transport error.
 *  - full:         no hello. Packets are
 *                    len(4, LE, counts itself + seq + payload + crc)
 *                    seq(4, LE, TCP sequence number, first packet 0)
 *                    payload
 *                    crc32(4, LE, over len + seq + payload)
 *                  per core.telegram.org/mtproto/mtproto-transports.
 *
 * @module
 */

/**
 * CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) — bit-for-bit identical
 * to `zlib.crc32()`. Implemented locally because `node:zlib` did not export
 * `crc32` until Node.js 20.15.0/22.2.0, while this SDK supports Node >= 18.17.
 * A differential test against zlib runs on Node >= 20.15.
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export type TransportName = 'abridged' | 'intermediate' | 'full';

/**
 * Maximum accepted payload per frame. The largest regular MTProto payload is
 * a 1 MiB upload.getFile chunk; 16 MiB leaves generous headroom while still
 * rejecting hostile length fields (and their allocations).
 */
const MAX_PAYLOAD_BYTES = 1 << 24;

/** Transport-level error (negative length in framing). */
export class TransportError extends Error {
  constructor(readonly code: number) {
    super(`transport error ${code}`);
    this.name = 'TransportError';
  }
}

export interface Transport {
  readonly name: TransportName;
  /** Bytes to send once when the connection opens (may be empty). */
  hello(): Uint8Array;
  /** Frame one payload. */
  encode(payload: Uint8Array): Uint8Array;
  /** Feed received bytes; returns every completed payload. */
  feed(chunk: Uint8Array): Uint8Array[];
}

/**
 * Base class with linear-time reassembly: chunks are queued and only
 * compacted when a full frame is actually available, so feeding a large
 * frame in many small chunks stays O(total bytes).
 */
abstract class BufferedTransport implements Transport {
  abstract readonly name: TransportName;
  private chunks: Buffer[] = [];
  private length = 0;

  abstract hello(): Uint8Array;
  abstract encode(payload: Uint8Array): Uint8Array;

  /** Try to parse one complete payload from the buffered bytes. */
  protected abstract tryParse(): Uint8Array | undefined;

  feed(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 0) {
      this.chunks.push(Buffer.from(chunk));
      this.length += chunk.length;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      const frame = this.tryParse();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  /** Total buffered bytes. */
  protected get buffered(): number {
    return this.length;
  }

  /** Read-only view of the first `n` buffered bytes, or null if not enough. */
  protected peek(n: number): Buffer | null {
    if (this.length < n) return null;
    const first = this.chunks[0];
    if (first === undefined || first.length < n) this.compact();
    const buf = this.chunks[0];
    return buf === undefined ? null : buf.subarray(0, n);
  }

  /** Consume the first `n` buffered bytes. */
  protected take(n: number): Buffer {
    let first = this.chunks[0];
    if (first === undefined || first.length < n) this.compact();
    first = this.chunks[0];
    if (first === undefined || first.length < n) {
      throw new Error('transport take: buffer underflow');
    }
    let out: Buffer;
    if (first.length === n) {
      out = first;
      this.chunks.shift();
    } else {
      out = first.subarray(0, n);
      this.chunks[0] = first.subarray(n);
    }
    this.length -= n;
    return out;
  }

  private compact(): void {
    this.chunks = [
      this.chunks.length <= 1 ? (this.chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(this.chunks, this.length),
    ];
  }

  /** Reject oversized frames before they can be allocated. */
  protected checkPayloadSize(len: number): void {
    if (len > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `${this.name} transport: frame payload ${len} exceeds the ${MAX_PAYLOAD_BYTES}-byte limit`,
      );
    }
  }

  /** Reject oversized encode inputs. */
  protected checkEncodeSize(len: number): void {
    if (len > MAX_PAYLOAD_BYTES) {
      throw new RangeError(
        `${this.name} transport: cannot frame ${len} bytes (limit ${MAX_PAYLOAD_BYTES})`,
      );
    }
  }
}

class AbridgedTransport extends BufferedTransport {
  readonly name = 'abridged' as const;

  hello(): Uint8Array {
    return new Uint8Array([0xef]);
  }

  encode(payload: Uint8Array): Uint8Array {
    if (payload.length === 0 || payload.length % 4 !== 0) {
      throw new RangeError(`abridged payload length must be a positive multiple of 4, got ${payload.length}`);
    }
    this.checkEncodeSize(payload.length);
    const quarters = payload.length / 4;
    if (quarters < 0x7f) {
      const out = new Uint8Array(1 + payload.length);
      out[0] = quarters;
      out.set(payload, 1);
      return out;
    }
    const out = new Uint8Array(4 + payload.length);
    out[0] = 0x7f;
    out[1] = quarters & 0xff;
    out[2] = (quarters >> 8) & 0xff;
    out[3] = (quarters >> 16) & 0xff;
    out.set(payload, 4);
    return out;
  }

  protected tryParse(): Uint8Array | undefined {
    const head = this.peek(1);
    if (!head) return undefined;
    const first = head[0]!;
    let quarters: number;
    let headerSize: number;
    if (first === 0x7f) {
      const h = this.peek(4);
      if (!h) return undefined;
      quarters = (h[1]! | (h[2]! << 8) | (h[3]! << 16)) >>> 0;
      headerSize = 4;
    } else {
      quarters = first;
      headerSize = 1;
    }
    const payloadLen = quarters * 4;
    this.checkPayloadSize(payloadLen);
    if (this.buffered < headerSize + payloadLen) return undefined;
    this.take(headerSize);
    return this.take(payloadLen);
  }
}

class IntermediateTransport extends BufferedTransport {
  readonly name = 'intermediate' as const;

  hello(): Uint8Array {
    const out = new Uint8Array(4);
    out.fill(0xee);
    return out;
  }

  encode(payload: Uint8Array): Uint8Array {
    this.checkEncodeSize(payload.length);
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setInt32(0, payload.length, true);
    out.set(payload, 4);
    return out;
  }

  protected tryParse(): Uint8Array | undefined {
    const h = this.peek(4);
    if (!h) return undefined;
    const len = h.readInt32LE(0);
    if (len < 0) {
      this.take(4);
      throw new TransportError(len);
    }
    this.checkPayloadSize(len);
    if (this.buffered < 4 + len) return undefined;
    this.take(4);
    return this.take(len);
  }
}

class FullTransport extends BufferedTransport {
  readonly name = 'full' as const;
  /** TCP sequence number of the next packet we send (first packet = 0). */
  private sendSeq = 0;

  hello(): Uint8Array {
    // the full transport has no magic bytes
    return new Uint8Array(0);
  }

  encode(payload: Uint8Array): Uint8Array {
    this.checkEncodeSize(payload.length);
    const header = Buffer.alloc(8);
    // the length counts the whole packet: length + seq + payload + crc
    header.writeUInt32LE(payload.length + 12, 0);
    header.writeUInt32LE(this.sendSeq, 4);
    this.sendSeq = (this.sendSeq + 1) >>> 0;
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(Buffer.concat([header, Buffer.from(payload)])) >>> 0, 0);
    return new Uint8Array(Buffer.concat([header, Buffer.from(payload), crc]));
  }

  protected tryParse(): Uint8Array | undefined {
    const h = this.peek(8);
    if (!h) return undefined;
    const total = h.readUInt32LE(0); // counts the whole packet
    if (total < 12) {
      throw new Error(`full transport: invalid packet length ${total}`);
    }
    const seq = h.readUInt32LE(4); // tracked, not enforced (per-connection)
    void seq;
    const payloadLen = total - 12;
    this.checkPayloadSize(payloadLen);
    if (this.buffered < total) return undefined;
    this.take(4); // length
    this.take(4); // seq
    const payload = this.take(payloadLen);
    const crcBytes = this.take(4);
    const crc = crcBytes.readUInt32LE(0);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(total, 0);
    header.writeUInt32LE(seq, 4);
    const expected = crc32(Buffer.concat([header, payload])) >>> 0;
    if (crc !== expected) {
      throw new Error(`full transport: CRC32 mismatch (got 0x${crc.toString(16)}, expected 0x${expected.toString(16)})`);
    }
    return payload;
  }
}

/** Create a transport by name. */
export function createTransport(name: TransportName): Transport {
  switch (name) {
    case 'abridged':
      return new AbridgedTransport();
    case 'intermediate':
      return new IntermediateTransport();
    case 'full':
      return new FullTransport();
    default:
      throw new RangeError(`unknown transport: ${name as string}`);
  }
}
