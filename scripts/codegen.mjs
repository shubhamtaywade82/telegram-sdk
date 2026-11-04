#!/usr/bin/env node
/**
 * Code generator: parses the TL schemas (src/tl/api.tl, src/tl/core.tl) and
 * emits descriptor tables (src/tl/schema-all.ts, src/tl/schema-core.ts).
 *
 * Run: node scripts/codegen.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYER = 232;

// Binary fields in the CORE schema are declared as `string` but carry raw
// bytes on the wire; rewrite them to `bytes` so the runtime returns
// Uint8Array for them.
const CORE_STRING_AS_BYTES = new Set([
  'resPQ:pq',
  'p_q_inner_data:pq', 'p_q_inner_data:p', 'p_q_inner_data:q',
  'p_q_inner_data_dc:pq', 'p_q_inner_data_dc:p', 'p_q_inner_data_dc:q',
  'p_q_inner_data_temp:pq', 'p_q_inner_data_temp:p', 'p_q_inner_data_temp:q',
  'p_q_inner_data_temp_dc:pq', 'p_q_inner_data_temp_dc:p', 'p_q_inner_data_temp_dc:q',
  'req_DH_params:p', 'req_DH_params:q', 'req_DH_params:encrypted_data',
  'set_client_DH_params:encrypted_data',
  'server_DH_params_ok:encrypted_answer',
  'server_DH_inner_data:dh_prime', 'server_DH_inner_data:g_a',
  'client_DH_inner_data:g_b',
]);

function parseTl(path, isCore) {
  const text = readFileSync(path, 'utf8');
  const out = { constructors: [], methods: [] };
  let mode = 'constructors';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//')) continue;
    if (line === '---functions---') { mode = 'methods'; continue; }
    if (line === '---types---') { mode = 'constructors'; continue; }
    if (line.startsWith('---')) continue;
    if (line.startsWith('vector#')) continue;
    if (line.startsWith('gzip_packed')) continue;
    if (/\{\w+:Type\}/.test(line)) continue; // generic wrapper declarations (invokeWithLayer & friends)
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const left = line.slice(0, eq).trim();
    const right = line.slice(eq + 1).split(';')[0].trim();
    const hash = left.indexOf('#');
    if (hash < 0) continue;
    const name = left.slice(0, hash).trim();
    const rest = left.slice(hash + 1).trim();
    const sp = rest.indexOf(' ');
    const idHex = (sp < 0 ? rest : rest.slice(0, sp)).trim();
    const argsStr = sp < 0 ? '' : rest.slice(sp + 1).trim();
    if (!/^[0-9a-fA-F]{1,8}$/.test(idHex)) {
      throw new Error(`bad constructor id in ${path}: ${line}`);
    }
    const id = Number.parseInt(idHex, 16) >>> 0;
    const args = [];
    if (argsStr) {
      for (const tok of argsStr.split(/\s+/)) {
        const c = tok.indexOf(':');
        if (c < 0) throw new Error(`bad arg token ${tok} in ${path}: ${line}`);
        let type = tok.slice(c + 1);
        if (isCore && CORE_STRING_AS_BYTES.has(`${name}:${tok.slice(0, c)}`)) type = 'bytes';
        args.push({ name: tok.slice(0, c), type });
      }
    }
    out[mode].push({ id, name, type: right, args });
  }
  return out;
}

function emitTs(constructorVar, methodVar, api) {
  const chunk = (list, kind) =>
    list
      .map((d) => {
        const args = d.args.length
          ? ` [${d.args.map((a) => `{ name: '${a.name}', type: '${a.type}' }`).join(', ')}]`
          : ' []';
        return `  { id: 0x${d.id.toString(16)}, kind: '${kind}', name: '${d.name}', type: '${d.type}', args:${args} },`;
      })
      .join('\n');
  return (
    `export const ${constructorVar}: readonly TLDescriptor[] = [\n${chunk(api.constructors, 'constructor')}\n];\n\n` +
    `export const ${methodVar}: readonly TLDescriptor[] = [\n${chunk(api.methods, 'method')}\n];\n`
  );
}

const api = parseTl(join(root, 'src/tl/api.tl'), false);
const core = parseTl(join(root, 'src/tl/core.tl'), true);

const header = (source, extra) =>
  `// GENERATED FILE - DO NOT EDIT.\n` +
  `// Source: ${source}\n` +
  `// Regenerate with: node scripts/codegen.mjs\n` +
  `import type { TLDescriptor } from './index.js';\n\n` +
  `export const LAYER = ${LAYER};\n\n` + extra;

writeFileSync(
  join(root, 'src/tl/schema-all.ts'),
  header('src/tl/api.tl (Layer 232 snapshot; tdesktop/teleproto)', emitTs('ALL_CONSTRUCTORS', 'ALL_METHODS', api)),
);
writeFileSync(
  join(root, 'src/tl/schema-core.ts'),
  header('src/tl/core.tl (core MTProto service schema)', emitTs('ALL_CORE_CONSTRUCTORS', 'ALL_CORE_METHODS', core)),
);

// stats + key descriptors for review
const types = new Set();
for (const d of [...api.constructors, ...api.methods, ...core.constructors, ...core.methods]) {
  for (const a of d.args) types.add(a.type);
}
console.log(`api: ${api.constructors.length} constructors, ${api.methods.length} methods`);
console.log(`core: ${core.constructors.length} constructors, ${core.methods.length} methods`);
console.log(`unique arg types: ${[...types].sort().join(' ')}`);
for (const d of [...core.constructors, ...core.methods]) {
  if (['resPQ', 'p_q_inner_data_dc', 'p_q_inner_data', 'server_DH_inner_data', 'client_DH_inner_data', 'rpc_result', 'rpc_error', 'msgs_ack', 'msg_container', 'bad_msg_notification'].includes(d.name)) {
    console.log(`key: ${d.name}#0x${d.id.toString(16)} args=${JSON.stringify(d.args)} type=${d.type}`);
  }
}
console.log('codegen OK');
