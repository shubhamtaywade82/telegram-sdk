/**
 * Dynamic TL layer: a schema-driven object model that serializes and parses
 * ANY constructor or method of the loaded layer. The generated data file
 * (`schema-all.ts`, built by `scripts/codegen.ts` from the official
 * `schema.json`) registers the full Layer here at import time.
 *
 * @module
 */

import { gunzipSync } from 'node:zlib';
import { TLReader, TLWriter } from '../binary.js';

/** A single parameter of a TL constructor/method, using schema.json types. */
export interface TLArg {
  readonly name: string;
  readonly type: string;
}

/** A TL constructor or method descriptor. */
export interface TLDescriptor {
  readonly kind: 'constructor' | 'method';
  readonly id: number;
  readonly name: string;
  /** Result type for methods; declared type for constructors. */
  readonly type: string;
  readonly args: readonly TLArg[];
}

/** Vector constructor id (`vector#1cb5c415`). */
export const TL_VECTOR_ID = 0x1cb5c415;
/** `gzip_packed` wrapper id. */
export const GZIP_PACKED_ID = 0x3072cfa1;
/** `boolTrue#997275b5`. */
export const BOOL_TRUE_ID = 0x997275b5;
/** `boolFalse#bc799737`. */
export const BOOL_FALSE_ID = 0xbc799737;

/** One TL value: a dynamic object with a constructor name and its arguments. */
export class TLObject {
  readonly kind: 'constructor' | 'method';
  readonly id: number;
  readonly name: string;
  readonly args: Record<string, unknown>;

  constructor(
    kind: 'constructor' | 'method',
    id: number,
    name: string,
    args: Record<string, unknown>,
  ) {
    this.kind = kind;
    this.id = id >>> 0;
    this.name = name;
    this.args = args;
  }

  /** Typed argument access helper. */
  get<T>(key: string): T {
    return this.args[key] as T;
  }
}

/** Registry of known constructors/methods, keyed by id and name. */
export class TLRegistry {
  private byId = new Map<number, TLDescriptor>();
  private constructorsByName = new Map<string, TLDescriptor>();
  private methodsByName = new Map<string, TLDescriptor>();

  register(descriptors: readonly TLDescriptor[]): void {
    for (const d of descriptors) {
      this.byId.set(d.id >>> 0, d);
      if (d.kind === 'method') this.methodsByName.set(d.name, d);
      else this.constructorsByName.set(d.name, d);
    }
  }

  constructorById(id: number): TLDescriptor | undefined {
    return this.byId.get(id >>> 0);
  }

  constructorByName(name: string): TLDescriptor | undefined {
    return this.constructorsByName.get(name);
  }

  methodByName(name: string): TLDescriptor | undefined {
    return this.methodsByName.get(name);
  }
}

/** The shared registry instance (populated by the generated `schema-all.ts`). */
export const registry = new TLRegistry();

/** Build a dynamic constructor object by predicate name. */
export function tl(name: string, args: Record<string, unknown> = {}): TLObject {
  const desc = registry.constructorByName(name);
  if (!desc) throw new Error(`unknown TL constructor: ${name} (is the schema loaded?)`);
  return new TLObject('constructor', desc.id, desc.name, args);
}

/** Build a dynamic method object by method name. */
export function tlMethod(name: string, args: Record<string, unknown> = {}): TLObject {
  const desc = registry.methodByName(name);
  if (!desc) throw new Error(`unknown TL method: ${name}`);
  return new TLObject('method', desc.id, desc.name, args);
}

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an object (constructor id + body) into `writer`
 * (a fresh one when omitted) and return it.
 */
export function serializeTLObject(obj: TLObject, writer: TLWriter = new TLWriter(), reg: TLRegistry = registry): TLWriter {
  const desc = obj.kind === 'method' ? reg.methodByName(obj.name) : reg.constructorByName(obj.name);
  if (!desc) {
    throw new Error(`unregistered TL object: ${obj.kind} ${obj.name} (is the schema loaded?)`);
  }
  writer.writeUint(desc.id);
  writeBody(writer, desc, obj.args, reg);
  return writer;
}

const CONDITIONAL = /^(\w+)\.(\d+)\?(.+)$/;

function writeBody(writer: TLWriter, desc: TLDescriptor, args: Record<string, unknown>, reg: TLRegistry): void {
  // 1) resolve flag parameters ('#') - auto-computed from present conditionals,
  //    unless the caller supplied an explicit value.
  const flagValues = new Map<string, number>();
  for (const a of desc.args) {
    if (a.type === '#') flagValues.set(a.name, (args[a.name] as number | undefined) ?? 0);
  }
  for (const a of desc.args) {
    const m = CONDITIONAL.exec(a.type);
    if (!m) continue;
    const present = args[a.name] !== undefined && args[a.name] !== false;
    if (present) flagValues.set(m[1], (flagValues.get(m[1]) ?? 0) | (1 << Number(m[2])));
  }
  // 2) write all arguments in declaration order. Conditional fields are
  //    driven by the FLAG BIT (exactly like the parser), never by value
  //    presence: several fields often share one bit (e.g. account.password's
  //    has_password/current_algo/srp_B/srp_id all use flags.2), so deciding
  //    by value would desynchronize writer and reader.
  for (const a of desc.args) {
    if (a.type === '#') {
      writer.writeUint(flagValues.get(a.name) ?? 0);
      continue;
    }
    const m = CONDITIONAL.exec(a.type);
    const value = args[a.name];
    if (m) {
      if (m[3] === 'true') continue; // presence-only flag: the bit is the value
      const bit = Number(m[2]);
      const set = ((flagValues.get(m[1]) ?? 0) >>> bit) & 1;
      if (set !== 1) continue; // bit clear: field absent
      if (value === undefined || value === false) {
        throw new TypeError(
          `${desc.kind} ${desc.name}: flag bit ${bit} of '${m[1]}' is set by a sibling field, ` +
            `but '${a.name}' (${m[3]}) is missing - fields sharing a flag bit must be provided together`,
        );
      }
      writeValue(writer, m[3], value, reg);
      continue;
    }
    if (value === undefined) {
      throw new TypeError(`missing argument ${a.name} for ${desc.kind} ${desc.name}`);
    }
    writeValue(writer, a.type, value, reg);
  }
}

function writeValue(writer: TLWriter, type: string, value: unknown, reg: TLRegistry): void {
  switch (type) {
    case 'int':
    case 'date':
      writer.writeInt(value as number);
      return;
    case '#':
      writer.writeUint(value as number);
      return;
    case 'long':
      writer.writeLong(value as bigint);
      return;
    case 'int128':
      writer.writeInt128(value as bigint);
      return;
    case 'int256':
      writer.writeInt256(value as bigint);
      return;
    case 'double':
      writer.writeDouble(value as number);
      return;
    case 'string':
      writer.writeString(value as string);
      return;
    case 'bytes':
      writer.writeBytes(value as Uint8Array);
      return;
    case 'Bool':
    case 'bool': {
      if (value === true) writer.writeUint(BOOL_TRUE_ID);
      else if (value === false) writer.writeUint(BOOL_FALSE_ID);
      else throw new TypeError(`expected boolean for ${type}, got ${typeof value}`);
      return;
    }
    default:
      break;
  }
  if (type.startsWith('Vector<') || type.startsWith('vector<')) {
    const elemType = type.slice(7, -1);
    const list = value as unknown[];
    if (!Array.isArray(list)) throw new TypeError(`expected array for ${type}`);
    if (type[0] === 'V') writer.writeUint(TL_VECTOR_ID); // boxed vector prefix
    writer.writeInt(list.length);
    for (const item of list) writeValue(writer, elemType, item, reg);
    return;
  }
  if (value instanceof TLObject) {
    const desc = value.kind === 'method' ? reg.methodByName(value.name) : reg.constructorByName(value.name);
    if (!desc) throw new Error(`unregistered nested TL object: ${value.name}`);
    writer.writeUint(desc.id);
    writeBody(writer, desc, value.args, reg);
    return;
  }
  throw new TypeError(`cannot serialize value of type ${typeof value} as TL type ${type}`);
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/**
 * Parse one TL object from the reader. `gzip_packed` wrappers are
 * transparently inflated. A bare top-level Vector cannot be parsed without
 * its element type - use `parseResult` for method results instead.
 */
export function parseTLObject(reader: TLReader, reg: TLRegistry = registry): TLObject {
  const id = reader.readUint();
  if (id === GZIP_PACKED_ID) {
    const data = reader.readBytes();
    return parseTLObject(new TLReader(gunzipSync(data)), reg);
  }
  if (id === TL_VECTOR_ID) {
    throw new Error('top-level bare Vector: parse it through parseResult (element type is needed)');
  }
  const desc = reg.constructorById(id);
  if (!desc) {
    throw new Error(`unknown TL constructor id 0x${(id >>> 0).toString(16)} at offset ${reader.pos - 4}`);
  }
  const args = readBody(reader, desc, reg);
  return new TLObject('constructor', desc.id, desc.name, args);
}

/**
 * Parse a method result: `type` is the method's declared result type
 * (e.g. `messages.Dialogs`, `Vector<User>`, `Vector<int>`), and a
 * `gzip_packed` wrapper is unwrapped first.
 */
export function parseResult(reader: TLReader, type: string, reg: TLRegistry = registry): unknown {
  const save = reader.pos;
  const id = reader.readUint();
  if (id === GZIP_PACKED_ID) {
    const data = reader.readBytes();
    return parseResult(new TLReader(gunzipSync(data)), type, reg);
  }
  reader.pos = save;
  return readValue(reader, type, reg);
}

function readBody(reader: TLReader, desc: TLDescriptor, reg: TLRegistry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const flagValues = new Map<string, number>();
  for (const a of desc.args) {
    if (a.type === '#') {
      const v = reader.readUint();
      flagValues.set(a.name, v);
      out[a.name] = v;
      continue;
    }
    const m = CONDITIONAL.exec(a.type);
    if (m) {
      const flagParam = m[1];
      const bit = Number(m[2]);
      const set = ((flagValues.get(flagParam) ?? 0) >>> bit) & 1;
      if (m[3] === 'true') {
        out[a.name] = set === 1;
        continue;
      }
      if (set !== 1) {
        out[a.name] = undefined;
        continue;
      }
      out[a.name] = readValue(reader, m[3], reg);
      continue;
    }
    out[a.name] = readValue(reader, a.type, reg);
  }
  return out;
}

function readValue(reader: TLReader, type: string, reg: TLRegistry): unknown {
  switch (type) {
    case 'int':
    case 'date':
      return reader.readInt();
    case '#':
      return reader.readUint();
    case 'long':
      return reader.readLong();
    case 'int128':
      return reader.readInt128();
    case 'int256':
      return reader.readInt256();
    case 'double':
      return reader.readDouble();
    case 'string':
      return reader.readString();
    case 'bytes':
      return reader.readBytes();
    case 'Bool':
    case 'bool': {
      const id = reader.readUint();
      if (id === BOOL_TRUE_ID) return true;
      if (id === BOOL_FALSE_ID) return false;
      throw new Error(`expected Bool, got constructor 0x${(id >>> 0).toString(16)} at offset ${reader.pos - 4}`);
    }
    default:
      break;
  }
  if (type.startsWith('Vector<') || type.startsWith('vector<')) {
    const elemType = type.slice(7, -1);
    if (type[0] === 'V') {
      const id = reader.readUint();
      if (id !== TL_VECTOR_ID) {
        throw new Error(`expected Vector id 0x1cb5c415, got 0x${(id >>> 0).toString(16)} at offset ${reader.pos - 4}`);
      }
    }
    const count = reader.readInt();
    if (count < 0) throw new Error(`negative Vector length ${count}`);
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) items.push(readValue(reader, elemType, reg));
    return items;
  }
  // named type: nested object
  return parseTLObject(reader, reg);
}
