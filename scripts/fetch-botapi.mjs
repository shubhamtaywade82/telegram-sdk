#!/usr/bin/env node
/**
 * Snapshots the official Bot API documentation into a deterministic JSON file.
 *
 *   node scripts/fetch-botapi.mjs                 # download https://core.telegram.org/bots/api
 *   node scripts/fetch-botapi.mjs --from <file>   # parse a saved copy offline
 *
 * Output: schema/bot-api/bot-api-<version>.json (types, methods, return types, source sha256).
 * HTML is parsed as text, never executed. Constructs the parser cannot resolve are reported
 * as warnings and make the script exit non-zero unless --allow-warnings is given.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_URL = 'https://core.telegram.org/bots/api';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

export const toText = (html) =>
  decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

export function parseVersion(html) {
  const heading = /<h4[^>]*>([\s\S]*?)<\/h4>/.exec(html);
  const m = /Bot API (\d+\.\d+)/.exec(html);
  if (!m) throw new Error('could not determine the Bot API version from the document');
  return { version: m[1], releaseDate: heading ? toText(heading[1]) : 'unknown' };
}

/** Sections begin at an <h3> or <h4> and run to the next heading of any level. */
function sections(html) {
  const marks = [];
  const re = /<h([34])[^>]*>([\s\S]*?)<\/h\1>/g;
  let m;
  while ((m = re.exec(html))) {
    marks.push({ level: Number(m[1]), name: toText(m[2]), start: m.index, bodyStart: m.index + m[0].length });
  }
  return marks.map((mk, i) => ({
    ...mk,
    body: html.slice(mk.bodyStart, i + 1 < marks.length ? marks[i + 1].start : html.length),
  }));
}

function tables(body) {
  const out = [];
  const re = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = re.exec(body))) {
    const t = m[0];
    const headers = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => toText(x[1]));
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]))
      .filter((cells) => cells.length > 0);
    out.push({ headers, rows });
  }
  return out;
}

function proseOf(body) {
  const cut = body.indexOf('<table');
  return toText(cut < 0 ? body : body.slice(0, cut));
}

/**
 * Extracts the return type from method prose. Rules are ordered from most to least specific;
 * the first match wins. Returns a Bot API type expression or null when nothing matches.
 */
export function extractReturn(prose) {
  const sentences = prose.split(/(?<=\.)\s+/).filter((x) => /\b(returns?|returned)\b/i.test(x));
  for (const sentence of sentences) {
    const hit = returnFromSentence(sentence);
    if (hit) return hit;
  }
  return null;
}

function returnFromSentence(sentence) {
  const arr = /\bArray of (?:an? |the )?([A-Z]\w*)/.exec(sentence);
  if (arr) return `Array of ${arr[1]}`;
  if (/\bTrue\b/.test(sentence) && /on success/i.test(sentence)) return "True";
  const prim = /\b(?:[Rr]eturns?|as|is)\s+(?:an? |the )?(String|Int|Integer|Float|Boolean)\b/.exec(sentence);
  if (prim) return prim[1] === "Int" ? "Integer" : prim[1];
  const onSuccess = /\b[Rr]eturns?\s+(?:an? |the )?(?:[\w-]+ )*?([A-Z]\w*)\s+on success\b/.exec(sentence);
  if (onSuccess) return onSuccess[1];
  const idOf = /\bthe ([A-Z]\w*) of the sent message\b/.exec(sentence);
  if (idOf) return idOf[1];
  const obj = /\b(?:an?|the)\s+(?:[\w-]+\s+)*?([A-Z]\w*)\s+object\b/.exec(sentence) ?? /\bas (?:an? )?([A-Z]\w*)\s+object\b/.exec(sentence);
  if (obj) return obj[1];
  const isRet = /\b(?:the |an? )?(?:[\w-]+ )*?([A-Z]\w*)\s+is returned\b/.exec(sentence);
  if (isRet) return isRet[1];
  return null;
}

export function parseBotApi(html) {
  const { version, releaseDate } = parseVersion(html);
  const secs = sections(html).filter((s) => s.level === 4 && /^[A-Za-z][A-Za-z0-9]*$/.test(s.name));
  const typeNames = secs.filter((s) => /^[A-Z]/.test(s.name)).map((s) => s.name);
  const typeSet = new Set(typeNames);
  const canonical = new Map(typeNames.map((n) => [n.toLowerCase(), n]));
  const types = [];
  const methods = [];
  const warnings = [];

  for (const s of secs) {
    const prose = proseOf(s.body);
    const tbls = tables(s.body);

    if (/^[a-z]/.test(s.name)) {
      const paramTable = tbls.find((t) => t.headers.includes('Parameter') && t.headers.includes('Required'));
      const returns = extractReturn(prose);
      if (!returns) warnings.push(`method ${s.name}: return type not found in prose`);
      const params = (paramTable?.rows ?? []).map((cells) => {
        const [name, type, required, ...desc] = cells.map(toText);
        return { name, type, required: required === 'Yes', description: desc.join(' ') };
      });
      methods.push({ name: s.name, description: prose, params, returns: returns ?? null });
      continue;
    }

    if (!/^[A-Z]/.test(s.name)) continue;
    const fieldTable = tbls.find((t) => t.headers.includes('Field') && t.headers.includes('Type'));
    const fields = (fieldTable?.rows ?? []).map((cells) => {
      const [name, type, ...desc] = cells.map(toText);
      const description = desc.join(' ');
      return { name, type, optional: /^Optional\./.test(description), description };
    });

    let union = null;
    if (!fieldTable) {
      const links = [];
      const linkRe = /href="#([a-z0-9]+)"/g;
      let m;
      while ((m = linkRe.exec(s.body))) {
        const target = canonical.get(m[1]);
        if (target && target !== s.name && !links.includes(target)) links.push(target);
      }
      const words = [...new Set(prose.match(/\b[A-Z][A-Za-z0-9]*\b/g) ?? [])].filter(
        (w) => typeSet.has(w) && w !== s.name,
      );
      const members = links.length > 0 ? links : words;
      if (members.length > 1 && /following|one of|supported|can be|must be/i.test(prose)) union = members;
      else if (!/placeholder|no information|represents|Describes|contains|object/i.test(prose)) {
        warnings.push(`type ${s.name}: no fields and no union members recognised`);
      }
    }
    types.push({ name: s.name, description: prose, fields, union });
  }
  return { version, releaseDate, types, methods, warnings };
}

async function download() {
  const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'telegram-sdk-botapi-snapshot' } });
  if (!res.ok) throw new Error(`GET ${SOURCE_URL} failed with HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const allowWarnings = args.includes('--allow-warnings');
  const html = fromIdx >= 0 ? readFileSync(args[fromIdx + 1], 'utf8') : await download();
  const parsed = parseBotApi(html);
  const out = {
    source: {
      url: SOURCE_URL,
      sha256: createHash('sha256').update(html).digest('hex'),
      retrievedAt: fromIdx >= 0 ? 'offline' : new Date().toISOString(),
    },
    botApiVersion: parsed.version,
    releaseDate: parsed.releaseDate,
    counts: { types: parsed.types.length, methods: parsed.methods.length },
    types: parsed.types,
    methods: parsed.methods,
  };
  const dir = join(root, 'schema/bot-api');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bot-api-${parsed.version}.json`);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${file}: ${parsed.types.length} types, ${parsed.methods.length} methods`);
  for (const w of parsed.warnings) console.warn(`warning: ${w}`);
  if (parsed.warnings.length > 0 && !allowWarnings) {
    console.error(`${parsed.warnings.length} unresolved construct(s); fix the parser or pass --allow-warnings`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
