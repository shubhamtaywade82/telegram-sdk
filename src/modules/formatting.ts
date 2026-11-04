/**
 * Pluggable message formatting.
 *
 * Built-in parsers for HTML and MarkdownV2 produce Telegram `messageEntity*`
 * objects with UTF-16 offsets. Messages from `@nemesis-oss/tg-format`
 * (the author's entity-first formatting library) are accepted as-is through
 * duck typing and converted automatically - install it and pass its
 * formatted messages directly to `sendMessage`.
 *
 * @module
 */

import { tl, type TLObject } from '../tl/index.js';

export type ParseMode = 'html' | 'markdownv2' | 'none';

/** A text plus ready-to-send message entities. */
export interface FormattedText {
  text: string;
  entities: TLObject[];
}

function makeEntity(name: string, offset: number, length: number, extra: Record<string, unknown> = {}): TLObject {
  return tl(name, { offset, length, ...extra });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_TAGS: Record<string, string> = {
  b: 'messageEntityBold',
  i: 'messageEntityItalic',
  u: 'messageEntityUnderline',
  s: 'messageEntityStrike',
  code: 'messageEntityCode',
  pre: 'messageEntityPre',
  spoiler: 'messageEntitySpoiler',
  blockquote: 'messageEntityBlockquote',
  a: 'messageEntityTextUrl',
};

/** Parse Telegram-compatible HTML into entities. */
export function parseHtml(input: string): FormattedText {
  let text = '';
  const entities: TLObject[] = [];
  const stack: Array<{ tag: string; start: number; url?: string; language?: string }> = [];
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      text += input.slice(i);
      break;
    }
    text += input.slice(i, lt);
    const gt = input.indexOf('>', lt);
    if (gt < 0) {
      text += input.slice(lt);
      break;
    }
    const tagContent = input.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (tagContent.startsWith('/')) {
      const tag = tagContent.slice(1).toLowerCase().split(/\s/)[0];
      const idx = stack.map((s) => s.tag).lastIndexOf(tag);
      if (idx >= 0) {
        const open = stack.splice(idx, 1)[0];
        const length = text.length - open.start;
        if (length > 0) {
          if (tag === 'a') entities.push(makeEntity('messageEntityTextUrl', open.start, length, { url: open.url ?? '' }));
          else if (tag === 'pre') entities.push(makeEntity('messageEntityPre', open.start, length, { language: open.language ?? '' }));
          else entities.push(makeEntity(HTML_TAGS[tag] ?? 'messageEntityBold', open.start, length));
        }
      }
      continue;
    }
    const m = /^([a-zA-Z0-9]+)(\s[^>]*)?$/.exec(tagContent);
    if (!m) continue; // drop malformed tag, keep content
    const tag = m[1].toLowerCase();
    if (!(tag in HTML_TAGS)) continue; // drop unknown tag, keep content
    const attrs = m[2] ?? '';
    stack.push({
      tag,
      start: text.length,
      url: /href\s*=\s*"([^"]*)"/.exec(attrs)?.[1],
      language: /class\s*=\s*"language-([^"]*)"/.exec(attrs)?.[1],
    });
  }
  return { text, entities };
}

// ---------------------------------------------------------------------------
// MarkdownV2 (subset)
// ---------------------------------------------------------------------------

/**
 * Parse a MarkdownV2 subset into entities.
 *
 * Supported marks: `*bold*`, `_italic_`, `__underline__`, `~strike~`,
 * `` `code` ``, fenced ` ```pre``` `, `||spoiler||`, and `&#91;text&#93;(url)` links.
 */
export function parseMarkdownV2(input: string): FormattedText {
  let text = '';
  const entities: TLObject[] = [];
  const stack: Array<{ mark: string; start: number }> = [];
  let i = 0;

  const closeExists = (token: string, from: number): boolean => input.indexOf(token, from) >= 0;

  const tryClose = (mark: string): boolean => {
    const idx = stack.map((s) => s.mark).lastIndexOf(mark);
    if (idx < 0) return false;
    const open = stack.splice(idx, 1)[0];
    const length = text.length - open.start;
    if (length > 0) {
      if (mark === '```') entities.push(makeEntity('messageEntityPre', open.start, length, { language: '' }));
      else if (mark === '||') entities.push(makeEntity('messageEntitySpoiler', open.start, length));
      else if (mark === '__') entities.push(makeEntity('messageEntityUnderline', open.start, length));
      else if (mark === '*') entities.push(makeEntity('messageEntityBold', open.start, length));
      else if (mark === '_') entities.push(makeEntity('messageEntityItalic', open.start, length));
      else if (mark === '~') entities.push(makeEntity('messageEntityStrike', open.start, length));
      else if (mark === '`') entities.push(makeEntity('messageEntityCode', open.start, length));
    }
    return true;
  };

  while (i < input.length) {
    // fenced code
    if (input.startsWith('```', i)) {
      if (stack.length > 0 && stack[stack.length - 1].mark === '```') {
        tryClose('```');
      } else if (closeExists('```', i + 3)) {
        stack.push({ mark: '```', start: text.length });
      } else {
        text += '```';
      }
      i += 3;
      continue;
    }
    // spoiler
    if (input.startsWith('||', i)) {
      if (stack.some((s) => s.mark === '||')) {
        tryClose('||');
      } else if (closeExists('||', i + 2)) {
        stack.push({ mark: '||', start: text.length });
      } else {
        text += '||';
      }
      i += 2;
      continue;
    }
    // link [text](url)
    if (input[i] === '[') {
      const closeIdx = input.indexOf('](', i);
      if (closeIdx >= 0) {
        const urlEnd = input.indexOf(')', closeIdx + 2);
        if (urlEnd >= 0) {
          const inner = input.slice(i + 1, closeIdx);
          const url = input.slice(closeIdx + 2, urlEnd);
          const start = text.length;
          text += inner;
          if (inner.length > 0) entities.push(makeEntity('messageEntityTextUrl', start, inner.length, { url }));
          i = urlEnd + 1;
          continue;
        }
      }
      text += '[';
      i += 1;
      continue;
    }
    // __underline__ (before _italic_)
    if (input.startsWith('__', i)) {
      if (stack.some((s) => s.mark === '__')) {
        tryClose('__');
        i += 2;
        continue;
      }
      if (closeExists('__', i + 2)) {
        stack.push({ mark: '__', start: text.length });
        i += 2;
        continue;
      }
      text += '__';
      i += 2;
      continue;
    }
    const ch = input[i];
    if (ch === '*' || ch === '_' || ch === '~' || ch === '`') {
      const mark = ch;
      if (stack.some((s) => s.mark === mark)) {
        tryClose(mark);
        i += 1;
        continue;
      }
      if (closeExists(mark, i + 1)) {
        stack.push({ mark, start: text.length });
        i += 1;
        continue;
      }
      text += ch;
      i += 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  return { text, entities };
}

// ---------------------------------------------------------------------------
// tg-format bridge
// ---------------------------------------------------------------------------

/** Minimal shape of a formatted message from @nemesis-oss/tg-format. */
export interface TgFormatLike {
  text: string;
  entities: Array<{
    type: string;
    offset: number;
    length: number;
    url?: string;
    user_id?: unknown;
    language?: string;
    collapsed?: boolean;
  }>;
}

const TG_FORMAT_TYPES: Record<string, string> = {
  bold: 'messageEntityBold',
  italic: 'messageEntityItalic',
  underline: 'messageEntityUnderline',
  strikethrough: 'messageEntityStrike',
  spoiler: 'messageEntitySpoiler',
  code: 'messageEntityCode',
  pre: 'messageEntityPre',
  text_link: 'messageEntityTextUrl',
  text_mention: 'messageEntityMentionName',
  blockquote: 'messageEntityBlockquote',
  expandable_blockquote: 'messageEntityBlockquote',
};

/** Convert a tg-format (or compatible) message into our entity form. */
export function fromTgFormat(message: TgFormatLike): FormattedText {
  const entities: TLObject[] = [];
  for (const e of message.entities ?? []) {
    const name = TG_FORMAT_TYPES[e.type];
    if (!name) continue;
    const extra: Record<string, unknown> = {};
    if (e.type === 'text_link') extra.url = e.url ?? '';
    if (e.type === 'text_mention') extra.user_id = e.user_id;
    if (e.type === 'pre') extra.language = e.language ?? '';
    if (e.type === 'expandable_blockquote') extra.collapsed = true;
    entities.push(makeEntity(name, e.offset, e.length, extra));
  }
  return { text: message.text, entities };
}

function isTgFormatLike(v: unknown): v is TgFormatLike {
  if (v === null || typeof v !== 'object') return false;
  const m = v as { text?: unknown; entities?: unknown };
  const first: unknown = (m.entities as unknown[])[0];
  return typeof m.text === 'string' && Array.isArray(m.entities) && m.entities.length > 0 && typeof first === 'object' && first !== null && 'type' in first;
}

function isOurFormatted(v: unknown): v is FormattedText {
  if (v === null || typeof v !== 'object') return false;
  const m = v as { text?: unknown; entities?: unknown };
  const first: unknown = (m.entities as unknown[])[0];
  return typeof m.text === 'string' && Array.isArray(m.entities) && (m.entities.length === 0 || (typeof first === 'object' && first !== null && 'name' in first));
}

/** Normalize any supported input (string, FormattedText, tg-format message) for sending. */
export function toSendable(input: string | FormattedText | TgFormatLike, parseMode: ParseMode = 'none'): FormattedText {
  if (typeof input === 'string') {
    if (parseMode === 'html') return parseHtml(input);
    if (parseMode === 'markdownv2') return parseMarkdownV2(input);
    return { text: input, entities: [] };
  }
  if (isTgFormatLike(input)) return fromTgFormat(input);
  if (isOurFormatted(input)) return input;
  return { text: String(input), entities: [] };
}

/** Apply a parse mode to a plain string (no-op for objects). */
export function applyParseMode(text: string, mode: ParseMode): FormattedText {
  return toSendable(text, mode);
}
