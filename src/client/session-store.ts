/**
 * Session persistence: JSON files and export/import strings.
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { MTProtoSession } from '../mtproto/session.js';
import type { TelegramClient } from './telegram-client.js';

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
}

/** Save the client's session to a JSON file. */
export function saveSession(client: TelegramClient, path: string): void {
  writeFileSync(path, JSON.stringify(sessionDataOf(client), null, 2));
}

/** Load a session file (null when missing/corrupt). */
export function loadSession(path: string): SessionData | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as SessionData;
    if (data.version !== 1 || typeof data.authKey !== 'string') return null;
    return data;
  } catch {
    return null;
  }
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
  };
}
