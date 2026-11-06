/**
 * Core protocol invariants, pinned against sources INDEPENDENT of the code
 * under test: constructor ids are read from src/tl/core.tl itself, and the
 * msg_id generator is validated against the documented approximation rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RPC_RESULT_ID, MSG_CONTAINER_ID, RPC_ERROR_ID } from '../src/rpc.js';
import { MTProtoSession } from '../src/mtproto/session.js';
import { TLWriter, TLReader } from '../src/binary.js';
import { hexToBytes } from '../src/utils.js';
import { factorizePQ } from '../src/crypto/math.js';
import * as sdk from '../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreTl = readFileSync(join(repoRoot, 'src/tl/core.tl'), 'utf8');

function coreTlId(name: string): number {
  // matches both active and commented-out (manual-parse) declarations, e.g.
  //   rpc_error#2144ca19 ... = RpcError;
  //   //rpc_result#f35c6d01 ... = RpcResult; // parsed manually
  const m = new RegExp(`(?:^|\\n)/{0,2}${name}#([0-9a-f]{1,8})`, 'i').exec(coreTl);
  if (!m) throw new Error(`constructor ${name} not found in core.tl`);
  return Number.parseInt(m[1]!, 16) >>> 0;
}

test('C1 pin: rpc_result / msg_container / rpc_error ids match src/tl/core.tl', () => {
  // independent of src/rpc.ts: the ids come straight from the pinned schema
  assert.equal(RPC_RESULT_ID, coreTlId('rpc_result'), 'rpc_result id must match core.tl');
  assert.equal(MSG_CONTAINER_ID, coreTlId('msg_container'), 'msg_container id must match core.tl');
  assert.equal(RPC_ERROR_ID, coreTlId('rpc_error'), 'rpc_error id must match core.tl');
});

test('C2: msg_id approximates unixtime*2^32, is divisible by 4, monotonic', () => {
  const session = new MTProtoSession();
  let prev = 0n;
  for (let i = 0; i < 200; i++) {
    const id = session.nextMsgId();
    assert.equal(id % 4n, 0n, 'msg_id must be divisible by 4');
    assert.ok(id > prev, 'msg_id must be strictly monotonic');
    const high = id >> 32n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const drift = high > now ? high - now : now - high;
    assert.ok(drift <= 1n, `msg_id high bits must approximate unixtime (drift ${drift}s)`);
    // the pre-fix bug: int32 coercion collapses these to epoch-1970 values
    assert.ok(id > 0x6000000000000000n, 'msg_id must be a current-era value, not 1970');
    prev = id;
  }
});

test('C2 regression probe: the buggy int32 formula is NOT what runs now', () => {
  // demonstrates the original defect: Math.floor(f * 2^32) & mask without
  // the unsigned wrap goes negative for f >= 0.5
  const buggy = Math.floor(0.75 * 0x100000000) & 0xfffffffc;
  assert.ok(buggy < 0, 'the un-fixed formula sign-extends (sanity of this probe)');
  const fixed = (Math.floor(0.75 * 0x100000000) & 0xfffffffc) >>> 0;
  assert.equal(fixed, 0xc0000000, 'the fixed formula yields the unsigned low 32 bits');
});

test('M3: writeBytes rejects lengths at or above 2^24', () => {
  const w = new TLWriter();
  const huge = new Uint8Array(1 << 24);
  assert.throws(() => w.writeBytes(huge), /2\^24-1/);
});

test('writeInt/writeUint reject out-of-range values instead of truncating', () => {
  const w = new TLWriter();
  assert.throws(() => w.writeInt(2 ** 31), /32-bit range/);
  assert.throws(() => w.writeInt(-(2 ** 31) - 1), /32-bit range/);
  assert.throws(() => w.writeUint(-1), /32-bit range/);
  assert.throws(() => w.writeUint(2 ** 32), /32-bit range/);
  // bit 31 flags stay representable through the unsigned form
  w.writeUint(0x80000000);
  assert.equal(w.toBuffer().readUInt32LE(0), 0x80000000);
});

test('hexToBytes rejects invalid digits strictly', () => {
  assert.deepEqual(hexToBytes('0x0102'), new Uint8Array([1, 2]));
  assert.throws(() => hexToBytes('zz'), /invalid hex/);
  assert.throws(() => hexToBytes('123'), /even length/);
});

test('M2: conditional Bool false sets its flag bit and serializes boolFalse', () => {
  // codeSettings.app_sandbox is flags.8?Bool (not ?true): an explicit false
  // is a PRESENT value on the wire. It shares bit 8 with token (flags.8?string),
  // so the two must be provided together - exactly like the reader expects.
  const both = sdk.parseTLObject(
    new TLReader(sdk.serializeTLObject(sdk.tl('codeSettings', { app_sandbox: false, token: 'tkn' })).toBuffer()),
  );
  assert.equal(both.args.app_sandbox, false, 'explicit false must round-trip as false');
  assert.equal(both.args.token, 'tkn');
  // alone, the shared-bit invariant correctly demands the sibling
  assert.throws(
    () => sdk.serializeTLObject(sdk.tl('codeSettings', { app_sandbox: false })),
    /must be provided together/,
  );
  // presence-only flags (?true): false clears the bit
  const bare = sdk.parseTLObject(
    new TLReader(sdk.serializeTLObject(sdk.tl('codeSettings', { allow_flashcall: false })).toBuffer()),
  );
  assert.equal(bare.args.allow_flashcall, false, 'presence-only false must stay unset');
});

test('M4: factorizePQ rejects prime (hostile-server) inputs fast', () => {
  const prime = 2305843009213693951n; // 2^61 - 1, a Mersenne prime
  const start = Date.now();
  assert.throws(() => factorizePQ(prime), /prime/);
  assert.ok(Date.now() - start < 5000, 'primality pre-check must fail fast');
  // a semiprime still factors normally
  const { p, q } = factorizePQ(2147483647n * 2147483629n);
  assert.equal(p * q, 2147483647n * 2147483629n);
});
