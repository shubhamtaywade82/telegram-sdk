/**
 * Session persistence: JSON files and export/import strings.
 *
 * @module
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MTProtoSession } from '../mtproto/session.js';
import type { TelegramClient } from './telegram-client.js';
import { tloToJson } from '../tl/index.js';

/** Persisted session (version 1). */
export interface SessionData {
  version: 1;
  dcId: number;
  /** base64 of the 256-byte auth key. */
  authKey: string;
  serverSalt: string;
  sessionId: string;
  timeOffset: number;
  savedAt: string;
  /** The authorized user (serialized with `tloToJson`), when logged in. */
  user?: unknown;
}

/** Discriminated result of loading a session file. */
export type LoadSessionResult =
  | { status: 'ok'; data: SessionData }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };

/**
 * Save the client's session to a JSON file. The write is atomic: a
 * crash mid-write can never truncate an existing session file.
 */
export function saveSession(client: TelegramClient, path: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(sessionDataOf(client), null, 2));
  renameSync(tmp, path);
}

/** Load a session file, distinguishing missing from corrupt files. */
export function loadSessionFile(path: string): LoadSessionResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'corrupt', error: String(err) };
  }
  try {
    const data = JSON.parse(text) as SessionData;
    if (data.version !== 1 || typeof data.authKey !== 'string') {
      return { status: 'corrupt', error: 'unrecognized session format' };
    }
    // validate the base64 payload eagerly so failures surface here
    const key = Buffer.from(data.authKey, 'base64');
    if (key.length !== 256) {
      return { status: 'corrupt', error: `auth key must be 256 bytes, got ${key.length}` };
    }
    return { status: 'ok', data };
  } catch (err) {
    return { status: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Load a session file (null when missing or corrupt). Prefer
 * `loadSessionFile` when the difference matters.
 */
export function loadSession(path: string): SessionData | null {
  const result = loadSessionFile(path);
  return result.status === 'ok' ? result.data : null;
}

/** Export the session as a string (base64 of the JSON). */
export function exportSessionString(client: TelegramClient): string {
  return Buffer.from(JSON.stringify(sessionDataOf(client)), 'utf8').toString('base64');
}

/** Import a session produced by `exportSessionString`. */
export function importSessionString(value: string): SessionData {
  const data = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as SessionData;
  if (data.version !== 1) throw new Error(`unsupported session version ${data.version}`);
  return data;
}

/** Apply persisted state to a live MTProto session. */
export function applySessionData(session: MTProtoSession, data: SessionData): void {
  const key = Buffer.from(data.authKey, 'base64');
  session.setAuthKey(key);
  session.serverSalt = BigInt(data.serverSalt);
  session.sessionId = BigInt(data.sessionId);
  session.timeOffset = data.timeOffset;
}

function sessionDataOf(client: TelegramClient): SessionData {
  const session = client.session;
  if (!session.authKey) throw new Error('cannot save a session without an auth key');
  return {
    version: 1,
    dcId: client.connection.dcId,
    authKey: Buffer.from(session.authKey).toString('base64'),
    serverSalt: session.serverSalt.toString(),
    sessionId: session.sessionId.toString(),
    timeOffset: session.timeOffset,
    savedAt: new Date().toISOString(),
    ...(client.me ? { user: tloToJson(client.me) } : {}),
  };
}
