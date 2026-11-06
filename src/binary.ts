/**
 * TL (Type Language) binary serialization primitives.
 *
 * MTProto writes all `int`/`long`/`int128`/`int256`/`double` fields
 * little-endian; "string" and "bytes" use the TL length-prefixed format
 * (1- or 4-byte header, data, zero padding to a multiple of 4). The
 * big-endian "natural number" encoding used inside DH values (pq, p, q,
 * dh_prime, RSA n) is applied by the callers, not here.
 *
 * @module
 */

/** Error thrown when a buffer cannot be parsed as TL. */
export class TLError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'TLError';
  }
}

/** Serializes values in the TL binary format. */
export class TLWriter {
  private chunks: Buffer[] = [];
  private total = 0;

  /** Bytes written so far. */
  get byteLength(): number {
    return this.total;
  }

  /** Finalize into a single Buffer. */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.total);
  }

  private push(buf: Uint8Array): this {
    this.chunks.push(Buffer.from(buf));
    this.total += buf.length;
    return this;
  }

  /** Raw bytes, no TL framing. */
  writeRaw(bytes: Uint8Array): this {
    return this.push(bytes);
  }

  /** 32-bit signed int, little-endian. */
  writeInt(value: number): this {
    if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new RangeError(`int out of 32-bit range: ${value}`);
    }
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(value | 0, 0);
    return this.push(buf);
  }

  /** 32-bit unsigned int, little-endian. */
  writeUint(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`uint out of 32-bit range: ${value}`);
    }
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0, 0);
    return this.push(buf);
  }

  /** 64-bit long, little-endian; accepts any signed or unsigned 64-bit value. */
  writeLong(value: bigint): this {
    if (value < -(1n << 63n) || value >= 1n << 64n) {
      throw new RangeError(`value out of range for 64-bit long field: ${value}`);
    }
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt.asUintN(64, value), 0);
    return this.push(buf);
  }

  /** 128-bit value, little-endian (as used for nonces and hashes). */
  writeInt128(value: bigint): this {
    return this.push(TLWriter.le(value, 128n));
  }

  /** 256-bit value, little-endian (as used for new_nonce). */
  writeInt256(value: bigint): this {
    return this.push(TLWriter.le(value, 256n));
  }

  /** 64-bit double, little-endian. */
  writeDouble(value: number): this {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    return this.push(buf);
  }

  /** TL `string`/`bytes`: length-prefixed, zero-padded to a multiple of 4. */
  writeBytes(bytes: Uint8Array): this {
    const len = bytes.length;
    // the 3-byte long-form length field cannot carry 2^24 or more
    if (len >= 0x1000000) {
      throw new RangeError(`TL string/bytes too large: ${len} bytes (max 2^24-1)`);
    }
    if (len < 254) {
      const header = Buffer.from([len]);
      const pad = (4 - ((1 + len) % 4)) % 4;
      this.push(header);
      this.push(bytes);
      if (pad > 0) this.push(Buffer.alloc(pad));
    } else {
      const header = Buffer.alloc(4);
      header[0] = 0xfe;
      header[1] = (len >>> 0) & 0xff;
      header[2] = (len >>> 8) & 0xff;
      header[3] = (len >>> 16) & 0xff;
      const pad = (4 - (len % 4)) % 4;
      this.push(header);
      this.push(bytes);
      if (pad > 0) this.push(Buffer.alloc(pad));
    }
    return this;
  }

  /** UTF-8 string. */
  writeString(text: string): this {
    return this.writeBytes(Buffer.from(text, 'utf8'));
  }

  private static le(value: bigint, bits: bigint): Buffer {
    if (value < 0n || value >= 1n << bits) throw new RangeError(`value out of range for ${bits}-bit field`);
    const size = Number(bits) / 8;
    const buf = Buffer.alloc(size);
    let v = value;
    for (let i = 0; i < size; i++) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return buf;
  }
}

/** Parses values in the TL binary format. */
export class TLReader {
  readonly buffer: Buffer;
  pos: number;

  constructor(buffer: Uint8Array, startPos = 0) {
    this.buffer = Buffer.from(buffer);
    this.pos = startPos;
  }

  /** Bytes remaining until the end of the buffer. */
  get remaining(): number {
    return this.buffer.length - this.pos;
  }

  /** True when at least one more byte can be read. */
  canRead(): boolean {
    return this.remaining > 0;
  }

  private need(n: number, what: string): number {
    if (n < 0 || this.remaining < n) {
      throw new TLError(`unexpected end of buffer while reading ${what} (need ${n}, have ${this.remaining})`, this.pos);
    }
    const start = this.pos;
    this.pos += n;
    return start;
  }

  /** Raw bytes, no TL framing. */
  readRaw(n: number): Uint8Array {
    return this.buffer.subarray(this.need(n, 'raw bytes'), this.pos);
  }

  /** One byte. */
  readByte(): number {
    return this.buffer[this.need(1, 'byte')]!;
  }

  /** 32-bit signed int, little-endian. */
  readInt(): number {
    return this.buffer.readInt32LE(this.need(4, 'int'));
  }

  /** 32-bit unsigned int, little-endian. */
  readUint(): number {
    return this.buffer.readUInt32LE(this.need(4, 'uint'));
  }

  /** 64-bit signed long, little-endian. */
  readLong(): bigint {
    return this.buffer.readBigInt64LE(this.need(8, 'long'));
  }

  /** 128-bit unsigned value, little-endian. */
  readInt128(): bigint {
    const start = this.need(16, 'int128');
    return TLReader.assembleLE(this.buffer, start, 16);
  }

  /** 256-bit unsigned value, little-endian. */
  readInt256(): bigint {
    const start = this.need(32, 'int256');
    return TLReader.assembleLE(this.buffer, start, 32);
  }

  /** 64-bit double, little-endian. */
  readDouble(): number {
    return this.buffer.readDoubleLE(this.need(8, 'double'));
  }

  /** TL `string`/`bytes`: length-prefixed, zero-padded to a multiple of 4. */
  readBytes(): Uint8Array {
    const first = this.readByte();
    let len: number;
    let headerSize: number;
    if (first < 254) {
      len = first;
      headerSize = 1;
    } else if (first === 0xfe) {
      const b1 = this.readByte();
      const b2 = this.readByte();
      const b3 = this.readByte();
      len = (b1 | (b2 << 8) | (b3 << 16)) >>> 0;
      if (len < 254) throw new TLError('long-form length must be >= 254', this.pos - 4);
      headerSize = 4;
    } else {
      throw new TLError(`invalid TL string length byte 0x${first.toString(16)}`, this.pos - 1);
    }
    const start = this.need(len, 'string data');
    const data = this.buffer.subarray(start, this.pos);
    const pad = (4 - ((headerSize + len) % 4)) % 4;
    if (pad > 0) this.need(pad, 'string padding');
    return data;
  }

  /** UTF-8 string. */
  readString(): string {
    return Buffer.from(this.readBytes()).toString('utf8');
  }

  private static assembleLE(buf: Buffer, start: number, size: number): bigint {
    let v = 0n;
    for (let i = size - 1; i >= 0; i--) {
      v = (v << 8n) | BigInt(buf[start + i]!);
    }
    return v;
  }
}
