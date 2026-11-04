import test from 'node:test';
import assert from 'node:assert/strict';
import { TlReader, TlWriter, parseTlSchema } from '../dist/index.js';

test('TL primitives round-trip int32, int64 and double', () => {
  const writer = new TlWriter();
  writer.writeInt32(-42).writeInt64(9007199254740993n).writeDouble(12.5);
  const reader = new TlReader(writer.toUint8Array());
  assert.equal(reader.readInt32(), -42);
  assert.equal(reader.readInt64(), 9007199254740993n);
  assert.equal(reader.readDouble(), 12.5);
  assert.equal(reader.remaining, 0);
});

test('TL bytes short and extended length forms round-trip with padding', () => {
  for (const length of [0, 1, 253, 254, 255, 1024]) {
    const value = Uint8Array.from({ length }, (_, index) => index % 251);
    const writer = new TlWriter();
    writer.writeBytes(value);
    const encoded = writer.toUint8Array();
    assert.equal(encoded.length % 4, 0);
    assert.deepEqual(new TlReader(encoded).readBytes(), value);
  }
});

test('TL reader and writer support strings, Bool constructors and vectors', () => {
  const writer = new TlWriter();
  writer.writeString('Hello 世界 👨‍👩‍👧‍👦').writeBool(true).writeBool(false);
  writer.writeVector([3, 5, 8], (target, value) => target.writeInt32(value));
  const reader = new TlReader(writer.toUint8Array());
  assert.equal(reader.readString(), 'Hello 世界 👨‍👩‍👧‍👦');
  assert.equal(reader.readBool(), true);
  assert.equal(reader.readBool(), false);
  assert.deepEqual(reader.readVector((target) => target.readInt32()), [3, 5, 8]);
});

test('TL declaration parser reads constructor and function sections', () => {
  const parsed = parseTlSchema([
    '---types---',
    'user#12345678 id:long name:string = User;',
    '---functions---',
    'users.getUsers#87654321 ids:Vector<long> = Vector<User>;',
  ].join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 0x12345678);
  assert.equal(parsed[0].resultType, 'User');
  assert.equal(parsed[1].section, 'functions');
  assert.equal(parsed[1].resultType, 'Vector<User>');
});

test('TL parser preserves optional flag field expressions', () => {
  const [definition] = parseTlSchema('user#12345678 flags:# username:flags.0?string premium:flags.1?true = User;');
  assert.deepEqual(definition.fields, [
    { name: 'flags', type: '#' },
    { name: 'username', type: 'flags.0?string' },
    { name: 'premium', type: 'flags.1?true' },
  ]);
});
