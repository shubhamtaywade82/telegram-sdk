/**
 * TCP transport framing for MTProto: `abridged`, `intermediate` and `full`.
 *
 *  - abridged:     hello byte 0xef; packets are quarter-word lengths
 *                  (1 byte, or 0x7f + 3-byte LE when >= 0x7f).
 *  - intermediate: hello 0xeeeeeeee; packets are 4-byte LE length + payload.
 *                  A negative length signals a transport error.
 *  - full:         hello bytes ef 00 00 00; packets are 4-byte LE length +
 *                  payload + CRC32 (over the length bytes + payload).
 *
 * @module
 */

import { crc32 } from 'node:zlib';

export type TransportName = 'abridged' | 'intermediate' | 'full';

/** Transport-level error (negative length in framing). */
export class TransportError extends Error {
  constructor(readonly code: number) {
    super(`transport error ${code}`);
    this.name = 'TransportError';
  }
}

export interface Transport {
  readonly name: TransportName;
  /** Bytes to send once when the connection opens. */
  hello(): Uint8Array;
  /** Frame one payload. */
  encode(payload: Uint8Array): Uint8Array;
  /** Feed received bytes; returns every completed payload. */
  feed(chunk: Uint8Array): Uint8Array[];
}

abstract class BufferedTransport implements Transport {
  abstract readonly name: TransportName;
  protected pending = Buffer.alloc(0);

  abstract hello(): Uint8Array;
  abstract encode(payload: Uint8Array): Uint8Array;

  /** Try to parse one complete payload from the pending buffer. */
  protected abstract tryParse(): Uint8Array | undefined;

  feed(chunk: Uint8Array): Uint8Array[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const out: Uint8Array[] = [];
    for (;;) {
      const frame = this.tryParse();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  /** Consumes `n` bytes from the pending buffer. */
  protected take(n: number): Buffer {
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  protected get buffered(): number {
    return this.pending.length;
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
    if (this.buffered < 1) return undefined;
    const first = this.pending[0];
    let quarters: number;
    let headerSize: number;
    if (first === 0x7f) {
      if (this.buffered < 4) return undefined;
      quarters = this.pending[1] | (this.pending[2] << 8) | (this.pending[3] << 16);
      headerSize = 4;
    } else {
      quarters = first;
      headerSize = 1;
    }
    const payloadLen = quarters * 4;
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
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setInt32(0, payload.length, true);
    out.set(payload, 4);
    return out;
  }

  protected tryParse(): Uint8Array | undefined {
    if (this.buffered < 4) return undefined;
    const len = this.pending.readInt32LE(0);
    if (len < 0) {
      this.take(4);
      throw new TransportError(len);
    }
    if (this.buffered < 4 + len) return undefined;
    this.take(4);
    return this.take(len);
  }
}

class FullTransport extends BufferedTransport {
  readonly name = 'full' as const;

  hello(): Uint8Array {
    return new Uint8Array([0xef, 0x00, 0x00, 0x00]);
  }

  encode(payload: Uint8Array): Uint8Array {
    const header = Buffer.alloc(4);
    header.writeInt32LE(payload.length, 0);
    const body = Buffer.concat([header, Buffer.from(payload)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(body) >>> 0, 0);
    return new Uint8Array(Buffer.concat([body, crc]));
  }

  protected tryParse(): Uint8Array | undefined {
    if (this.buffered < 4) return undefined;
    const len = this.pending.readInt32LE(0);
    if (len < 0) {
      this.take(4);
      throw new TransportError(len);
    }
    if (this.buffered < 4 + len + 4) return undefined;
    this.take(4);
    const payload = this.take(len);
    const crc = this.take(4).readUInt32LE(0);
    const header = Buffer.alloc(4);
    header.writeInt32LE(len, 0);
    const expected = crc32(Buffer.concat([header, payload])) >>> 0;
    if (crc !== expected) {
      throw new Error(`full transport: CRC32 mismatch (got ${crc}, expected ${expected})`);
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
