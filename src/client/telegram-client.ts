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
import { jsonToTlo, registry, serializeTLObject, type TLObject } from '../tl/index.js';
import { LAYER } from '../tl/schema-all.js';
import { TLWriter } from '../binary.js';
import { TELEGRAM_RSA_KEYS } from '../crypto/rsa-keys.js';
import type { TelegramRsaKey } from '../crypto/rsa.js';
import { sleep } from '../utils.js';
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
  /** Per-invoke RPC timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** App version reported through initConnection (default '0.2.0'). */
  appVersion?: string;
  /** Max automatic reconnect attempts after an unexpected disconnect. */
  maxReconnects?: number;
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
    const key = `${ent.kind}:${ent.id}`;
    const existing = this.byId.get(key);
    let winner = ent;
    if (existing && existing.accessHash !== 0n && ent.accessHash === 0n) {
      // a reduced entity (no access hash) must never erase a known-good one
      winner = {
        kind: existing.kind,
        id: existing.id,
        accessHash: existing.accessHash,
        username: ent.username ?? existing.username,
        title: ent.title ?? existing.title,
      };
    }
    this.byId.set(key, winner);
    if (winner.username) this.byUsername.set(winner.username.toLowerCase(), winner);
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

/** `invokeWithLayer#da9b0d0d layer:int query:!X = X` (api.tl; generic, unregistered). */
const INVOKE_WITH_LAYER_ID = 0xda9b0d0d;
/** `initConnection#c1cd5ea9 flags:# api_id:int ... query:!X = X` (api.tl; generic, unregistered). */
const INIT_CONNECTION_ID = 0xc1cd5ea9;

/**
 * Serialize `invokeWithLayer(layer, initConnection(..., query))` — the form
 * the server expects for the first API call of a connection.
 */
function wrapWithInitConnection(
  method: TLObject,
  apiId: number,
  appVersion: string,
): Uint8Array {
  const w = new TLWriter();
  w.writeUint(INVOKE_WITH_LAYER_ID);
  w.writeInt(LAYER);
  w.writeUint(INIT_CONNECTION_ID);
  w.writeUint(0); // flags (no proxy, no params)
  w.writeInt(apiId);
  w.writeString('mtproto-sdk'); // device_model
  w.writeString(`${process.platform} Node ${process.version}`); // system_version
  w.writeString(appVersion); // app_version
  w.writeString('en'); // system_lang_code
  w.writeString(''); // lang_pack
  w.writeString('en'); // lang_code
  serializeTLObject(method, w); // the inner query (bare: id + body)
  return w.toBuffer();
}

/** High-level Telegram client over MTProto. */
export class TelegramClient {
  session: MTProtoSession;
  connection: MTProtoConnection;
  invoker: MTProtoInvoker;
  readonly entityCache = new EntityCache();
  readonly parseModeDefault: ParseMode;
  me: TLObject | null = null;

  private messagingModule: Messaging | null = null;
  private mediaModule: Media | null = null;
  private updatesModule: Updates | null = null;
  private rsaKeys: readonly TelegramRsaKey[] | null = null;
  private needsInitConnection = true;
  private userClosed = false;
  private reconnecting = false;
  private readonly appVersion: string;
  private readonly maxReconnects: number;

  constructor(readonly options: TelegramClientOptions) {
    this.session = new MTProtoSession();
    this.parseModeDefault = options.parseModeDefault ?? 'html';
    this.appVersion = options.appVersion ?? '0.2.0';
    this.maxReconnects = options.maxReconnects ?? 5;

    // resolve the DC before building the connection
    let dcId = options.dcId ?? 2;
    let sessionData: SessionData | null = null;
    if (options.session) {
      sessionData = typeof options.session === 'string' ? importB64(options.session) : options.session;
      if (options.dcId === undefined && sessionData.dcId) dcId = sessionData.dcId;
      if (sessionData) applySessionData(this.session, sessionData);
    }
    const host = options.host ?? (PRODUCTION_DCS[dcId] ?? PRODUCTION_DCS[2]!);
    this.connection = this.buildConnection(host, dcId);
    this.invoker = this.buildInvoker();
    if (sessionData?.user) {
      this.me = jsonToTlo(sessionData.user);
      // the restored user is immediately usable as a peer
      this.entityCache.update(this.me);
    }
  }

  private buildConnection(host: string, dcId: number): MTProtoConnection {
    const conn = new MTProtoConnection({
      host,
      port: this.options.port ?? 443,
      dcId,
      transport: this.options.transport ?? 'intermediate',
    });
    conn.onClose = () => {
      if (!this.userClosed) void this.handleDisconnect();
    };
    conn.onError = () => {
      // surfaced through onClose (the socket always closes on error)
    };
    return conn;
  }

  private buildInvoker(): MTProtoInvoker {
    const invoker = new MTProtoInvoker(this.connection, this.session, {
      timeoutMs: this.options.timeoutMs,
    });
    invoker.onUpdate = (update) => {
      this.updatesModule?.handleUpdate(update);
    };
    return invoker;
  }

  /**
   * Connect (creating the auth key when needed) and start the RPC loop.
   * `rsaKeys` overrides the built-in server keys (used by tests with mock
   * servers). Idempotent: a second call is a no-op.
   */
  async connect(rsaKeys?: readonly TelegramRsaKey[]): Promise<void> {
    this.userClosed = false;
    if (rsaKeys) this.rsaKeys = rsaKeys;
    if (this.connection.isConnected) return;
    await this.connection.connect();
    if (!this.session.authKey) {
      await createAuthKey(this.connection, this.session, this.rsaKeys ?? TELEGRAM_RSA_KEYS, {
        rsaScheme: 'auto',
      });
    }
    this.needsInitConnection = true;
    this.invoker.start();
  }

  /** Disconnect and stop the RPC loop. No automatic reconnect afterwards. */
  async disconnect(): Promise<void> {
    this.userClosed = true;
    this.invoker.stop();
    this.connection.close();
  }

  /** Whether the underlying connection is currently open. */
  get connected(): boolean {
    return this.connection.isConnected;
  }

  /**
   * Move the client to another datacenter (PHONE/NETWORK/USER_MIGRATE_X):
   * auth keys are per-DC, so a fresh handshake is performed. The entity
   * cache and login state are preserved.
   */
  async switchDc(dcId: number): Promise<void> {
    if (dcId < 1 || dcId > 5) throw new Error(`invalid DC id ${dcId}`);
    this.invoker.stop();
    this.connection.close();
    // the auth key and salt belong to the old DC only
    this.session.setAuthKey(null);
    this.session.serverSalt = 0n;
    const host = this.options.host ?? (PRODUCTION_DCS[dcId] ?? PRODUCTION_DCS[2]!);
    this.connection = this.buildConnection(host, dcId);
    this.invoker = this.buildInvoker();
    await this.connection.connect();
    await createAuthKey(this.connection, this.session, this.rsaKeys ?? TELEGRAM_RSA_KEYS, {
      rsaScheme: 'auto',
    });
    this.needsInitConnection = true;
    this.invoker.start();
  }

  private async handleDisconnect(): Promise<void> {
    if (this.reconnecting || this.userClosed) return;
    this.reconnecting = true;
    try {
      this.invoker.stop(); // fail pending invokes promptly
      for (let attempt = 1; attempt <= this.maxReconnects; attempt++) {
        await sleep(Math.min(400 * 2 ** (attempt - 1), 8000));
        if (this.userClosed) return;
        try {
          // the auth key stays valid for the same DC: reconnect + resume
          await this.connection.connect();
          this.needsInitConnection = true;
          this.invoker.start();
          return;
        } catch {
          // retry with backoff
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Invoke any TL method (dynamic). The first call after connect is wrapped
   * in `invokeWithLayer(initConnection(...))` so the server learns the layer.
   */
  invoke<T = unknown>(method: TLObject): Promise<T> {
    if (this.needsInitConnection) {
      this.needsInitConnection = false;
      const desc = registry.methodByName(method.name);
      const body = wrapWithInitConnection(method, this.options.apiId, this.appVersion);
      return this.invoker.invokeSerialized<T>(method.name, body, desc?.type ?? 'Object', method);
    }
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
