/**
 * The main client: connection + session + invoker + auth key + entity cache,
 * with lazy feature modules (messaging, media, updates).
 *
 * @module
 */

import { createAuthKey } from '../mtproto/auth-key.js';
import { MTProtoConnection, PRODUCTION_DCS } from '../mtproto/connection.js';
import type { TransportName } from '../mtproto/transports.js';
import { MTProtoSession } from '../mtproto/session.js';
import { MTProtoInvoker } from '../rpc.js';
import type { TLObject } from '../tl/index.js';
import { TELEGRAM_RSA_KEYS } from '../crypto/rsa-keys.js';
import type { TelegramRsaKey } from '../crypto/rsa.js';
import { applySessionData, type SessionData } from './session-store.js';
import type { ParseMode } from '../modules/formatting.js';
import { Messaging } from '../modules/messaging.js';
import { Media } from '../modules/media.js';
import { Updates } from '../modules/updates.js';

export interface TelegramClientOptions {
  apiId: number;
  apiHash: string;
  dcId?: number;
  host?: string;
  port?: number;
  transport?: TransportName;
  /** A `SessionData` object, or a string from `exportSessionString`. */
  session?: SessionData | string;
  /** Default parse mode for sendMessage (default: 'html'). */
  parseModeDefault?: ParseMode;
}

/** A cached peer (user/chat/channel) with its access hash. */
export interface CachedEntity {
  kind: 'user' | 'chat' | 'channel';
  id: bigint;
  accessHash: bigint;
  username?: string;
  title?: string;
}

/** Tracks peers seen in responses so they can be used as InputPeers later. */
export class EntityCache {
  private byId = new Map<string, CachedEntity>();
  private byUsername = new Map<string, CachedEntity>();

  /** Feed users/chats (TLObjects or arrays of them, possibly nested in updates). */
  update(...values: unknown[]): void {
    for (const value of values) this.updateOne(value);
  }

  private updateOne(value: unknown): void {
    if (Array.isArray(value)) {
      for (const v of value) this.updateOne(v);
      return;
    }
    if (value === null || typeof value !== 'object' || !('name' in value)) return;
    const obj = value as { name: string; args: Record<string, unknown> };
    if (obj.name === 'user' && obj.args.id !== undefined) {
      this.store({
        kind: 'user',
        id: obj.args.id as bigint,
        accessHash: (obj.args.access_hash as bigint | undefined) ?? 0n,
        username: obj.args.username as string | undefined,
        title: (obj.args.first_name as string | undefined) ?? undefined,
      });
      return;
    }
    if ((obj.name === 'chat' || obj.name === 'channel') && obj.args.id !== undefined) {
      this.store({
        kind: obj.name as 'chat' | 'channel',
        id: obj.args.id as bigint,
        accessHash: (obj.args.access_hash as bigint | undefined) ?? 0n,
        username: obj.args.username as string | undefined,
        title: obj.args.title as string | undefined,
      });
    }
  }

  private store(ent: CachedEntity): void {
    this.byId.set(`${ent.kind}:${ent.id}`, ent);
    if (ent.username) this.byUsername.set(ent.username.toLowerCase(), ent);
  }

  /** Look up by username (with or without @) or numeric id string. */
  resolve(reference: string): CachedEntity | undefined {
    if (reference.startsWith('@')) return this.byUsername.get(reference.slice(1).toLowerCase());
    if (/^\d+$/.test(reference)) {
      for (const kind of ['user', 'chat', 'channel'] as const) {
        const hit = this.byId.get(`${kind}:${BigInt(reference)}`);
        if (hit) return hit;
      }
    }
    return this.byUsername.get(reference.toLowerCase());
  }

  /** All cached entities (for debugging). */
  get all(): CachedEntity[] {
    return [...this.byId.values()];
  }
}

/** High-level Telegram client over MTProto. */
export class TelegramClient {
  readonly session: MTProtoSession;
  readonly connection: MTProtoConnection;
  readonly invoker: MTProtoInvoker;
  readonly entityCache = new EntityCache();
  readonly parseModeDefault: ParseMode;
  me: TLObject | null = null;

  private messagingModule: Messaging | null = null;
  private mediaModule: Media | null = null;
  private updatesModule: Updates | null = null;

  constructor(readonly options: TelegramClientOptions) {
    this.session = new MTProtoSession();
    this.parseModeDefault = options.parseModeDefault ?? 'html';

    // resolve the DC before building the connection
    let dcId = options.dcId ?? 2;
    let sessionData: SessionData | null = null;
    if (options.session) {
      sessionData = typeof options.session === 'string' ? importB64(options.session) : options.session;
      if (options.dcId === undefined && sessionData.dcId) dcId = sessionData.dcId;
      if (sessionData) applySessionData(this.session, sessionData);
    }
    const host = options.host ?? PRODUCTION_DCS[dcId] ?? PRODUCTION_DCS[2];
    this.connection = new MTProtoConnection({
      host,
      port: options.port ?? 443,
      dcId,
      transport: options.transport ?? 'intermediate',
    });
    this.invoker = new MTProtoInvoker(this.connection, this.session);
    this.invoker.onUpdate = (update) => {
      this.updatesModule?.handleUpdate(update);
    };
  }

  /**
   * Connect (creating the auth key when needed) and start the RPC loop.
   * `rsaKeys` overrides the built-in server keys (used by tests with mock
   * servers).
   */
  async connect(rsaKeys?: readonly TelegramRsaKey[]): Promise<void> {
    await this.connection.connect();
    if (!this.session.authKey) {
      await createAuthKey(this.connection, this.session, rsaKeys ?? TELEGRAM_RSA_KEYS, {
        rsaScheme: 'auto',
      });
    }
    this.invoker.start();
  }

  /** Disconnect and stop the RPC loop. */
  async disconnect(): Promise<void> {
    this.invoker.stop();
    this.connection.close();
  }

  /** Invoke any TL method (dynamic). */
  invoke<T = unknown>(method: TLObject): Promise<T> {
    return this.invoker.invoke<T>(method);
  }

  get messaging(): Messaging {
    if (!this.messagingModule) this.messagingModule = new Messaging(this);
    return this.messagingModule;
  }

  get media(): Media {
    if (!this.mediaModule) this.mediaModule = new Media(this);
    return this.mediaModule;
  }

  get updates(): Updates {
    if (!this.updatesModule) this.updatesModule = new Updates(this);
    return this.updatesModule;
  }
}

function importB64(value: string): SessionData {
  const data = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as SessionData;
  if (data.version !== 1) throw new Error(`unsupported session version ${data.version}`);
  return data;
}
