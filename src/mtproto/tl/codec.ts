const VECTOR_CONSTRUCTOR = 0x1cb5c415;
const BOOL_TRUE_CONSTRUCTOR = 0x997275b5;
const BOOL_FALSE_CONSTRUCTOR = 0xbc799737;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** TL binary writer. Values are encoded little-endian and byte strings are padded to 4-byte boundaries. */
export class TlWriter {
  #buffer: Uint8Array;
  #offset = 0;

  constructor(initialCapacity = 128) {
    if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 0) throw new RangeError('Invalid initialCapacity');
    this.#buffer = new Uint8Array(Math.max(4, initialCapacity));
  }

  get length(): number { return this.#offset; }

  writeInt32(value: number): this {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError('TL int must be signed 32-bit');
    this.#ensure(4);
    new DataView(this.#buffer.buffer).setInt32(this.#offset, value, true);
    this.#offset += 4;
    return this;
  }

  writeUInt32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('TL uint must be unsigned 32-bit');
    this.#ensure(4);
    new DataView(this.#buffer.buffer).setUint32(this.#offset, value, true);
    this.#offset += 4;
    return this;
  }

  writeInt64(value: bigint): this {
    if (value < -(1n << 63n) || value > (1n << 63n) - 1n) throw new RangeError('TL long must be signed 64-bit');
    this.#ensure(8);
    new DataView(this.#buffer.buffer).setBigInt64(this.#offset, value, true);
    this.#offset += 8;
    return this;
  }

  writeDouble(value: number): this {
    this.#ensure(8);
    new DataView(this.#buffer.buffer).setFloat64(this.#offset, value, true);
    this.#offset += 8;
    return this;
  }

  writeBool(value: boolean): this {
    return this.writeUInt32(value ? BOOL_TRUE_CONSTRUCTOR : BOOL_FALSE_CONSTRUCTOR);
  }

  writeRawBytes(value: Uint8Array): this {
    this.#ensure(value.length);
    this.#buffer.set(value, this.#offset);
    this.#offset += value.length;
    return this;
  }

  writeBytes(value: Uint8Array): this {
    if (value.length > 0xffffff) throw new RangeError('TL bytes cannot exceed 16,777,215 bytes');
    const start = this.#offset;
    if (value.length <= 253) this.#byte(value.length);
    else {
      this.#byte(254);
      this.#byte(value.length & 0xff);
      this.#byte((value.length >>> 8) & 0xff);
      this.#byte((value.length >>> 16) & 0xff);
    }
    this.writeRawBytes(value);
    const padding = (4 - ((this.#offset - start) % 4)) % 4;
    for (let i = 0; i < padding; i += 1) this.#byte(0);
    return this;
  }

  writeString(value: string): this { return this.writeBytes(encoder.encode(value)); }

  writeVector<T>(values: readonly T[], writeItem: (writer: TlWriter, value: T) => void): this {
    this.writeUInt32(VECTOR_CONSTRUCTOR).writeInt32(values.length);
    for (const value of values) writeItem(this, value);
    return this;
  }

  toUint8Array(): Uint8Array { return this.#buffer.slice(0, this.#offset); }

  #byte(value: number): void {
    this.#ensure(1);
    this.#buffer[this.#offset] = value;
    this.#offset += 1;
  }

  #ensure(size: number): void {
    const required = this.#offset + size;
    if (required <= this.#buffer.length) return;
    let capacity = this.#buffer.length;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.#buffer);
    this.#buffer = next;
  }
}

/** TL binary reader with bounds checks on all reads. */
export class TlReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) { this.#bytes = bytes; }
  get offset(): number { return this.#offset; }
  get remaining(): number { return this.#bytes.length - this.#offset; }

  readInt32(): number {
    this.#ensure(4);
    const value = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength).getInt32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  readUInt32(): number {
    this.#ensure(4);
    const value = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength).getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  readInt64(): bigint {
    this.#ensure(8);
    const value = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength).getBigInt64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  readDouble(): number {
    this.#ensure(8);
    const value = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength).getFloat64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  readBool(): boolean {
    const value = this.readUInt32();
    if (value === BOOL_TRUE_CONSTRUCTOR) return true;
    if (value === BOOL_FALSE_CONSTRUCTOR) return false;
    throw new TypeError('Unknown TL Bool constructor: 0x' + value.toString(16));
  }

  readRawBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid TL byte length');
    this.#ensure(length);
    const value = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  readBytes(): Uint8Array {
    const start = this.#offset;
    const first = this.#byte();
    let length: number;
    if (first <= 253) length = first;
    else if (first === 254) {
      const a = this.#byte();
      const b = this.#byte();
      const c = this.#byte();
      length = a | (b << 8) | (c << 16);
    } else throw new TypeError('Invalid TL bytes length prefix 255');
    const value = this.readRawBytes(length);
    const padding = (4 - ((this.#offset - start) % 4)) % 4;
    this.#ensure(padding);
    this.#offset += padding;
    return value;
  }

  readString(): string { return decoder.decode(this.readBytes()); }

  readVector<T>(readItem: (reader: TlReader) => T): T[] {
    const magic = this.readUInt32();
    if (magic !== VECTOR_CONSTRUCTOR) throw new TypeError('Invalid TL vector constructor: 0x' + magic.toString(16));
    const count = this.readInt32();
    if (count < 0 || count > 1_000_000) throw new RangeError('Invalid TL vector length: ' + count);
    return Array.from({ length: count }, () => readItem(this));
  }

  #byte(): number {
    this.#ensure(1);
    const value = this.#bytes[this.#offset] as number;
    this.#offset += 1;
    return value;
  }

  #ensure(size: number): void {
    if (this.#offset + size > this.#bytes.length) throw new RangeError('Unexpected end of TL buffer');
  }
}
