/**
 * Messaging: peer resolution, sendMessage, getHistory, getDialogs.
 *
 * @module
 */

import { tl, tlMethod, type TLObject } from '../tl/index.js';
import { randomLong } from '../utils.js';
import { toSendable, type FormattedText, type ParseMode, type TgFormatLike } from './formatting.js';
import type { CachedEntity, TelegramClient } from '../client/telegram-client.js';

export interface SendMessageOptions {
  replyTo?: number;
  parseMode?: ParseMode;
  /** Disable the link preview (web page snippet). */
  linkPreview?: boolean;
  /** Deliver silently (no notification sound/vibration for recipients). */
  silent?: boolean;
  entities?: TLObject[];
}

/** Peer resolution + message sending + history. */
export class Messaging {
  constructor(private readonly client: TelegramClient) {}

  private entityToInputPeer(ent: CachedEntity): TLObject {
    if (ent.kind === 'user') {
      return tl('inputPeerUser', { user_id: ent.id, access_hash: ent.accessHash });
    }
    if (ent.kind === 'channel') {
      return tl('inputPeerChannel', { channel_id: ent.id, access_hash: ent.accessHash });
    }
    return tl('inputPeerChat', { chat_id: ent.id });
  }

  /** Chats are addressable by id alone; users and channels need an access hash. */
  private needsAccessHash(ent: CachedEntity): boolean {
    return ent.kind !== 'chat' && ent.accessHash === 0n;
  }

  /** Synchronously resolve cached peers / 'me' / ready InputPeer objects. */
  toInputPeer(ref: string | bigint | CachedEntity | TLObject): TLObject {
    if (typeof ref === 'object' && ref !== null && 'name' in ref) return ref as TLObject;
    if (typeof ref === 'object' && ref !== null && 'kind' in ref) return this.entityToInputPeer(ref as CachedEntity);
    if (typeof ref === 'bigint') {
      const ent = this.client.entityCache.resolve(ref.toString());
      if (!ent || this.needsAccessHash(ent)) {
        throw new Error(`peer ${ref} is not cached (no access hash); use await resolvePeer() or getDialogs() first`);
      }
      return this.entityToInputPeer(ent);
    }
    const s = ref.trim();
    if (s === 'me' || s === 'self') return tl('inputPeerSelf', {});
    const cached = this.client.entityCache.resolve(s);
    if (cached && !this.needsAccessHash(cached)) return this.entityToInputPeer(cached);
    throw new Error(`peer ${s} is not cached; use await resolvePeer() (network) or getDialogs() first`);
  }

  /** Resolve a peer to an InputPeer, hitting the network (username lookup) when needed. */
  async resolvePeer(ref: string | bigint | CachedEntity | TLObject): Promise<TLObject> {
    if (typeof ref === 'object' && ref !== null && 'name' in ref) return ref as TLObject;
    if (typeof ref === 'object' && ref !== null && 'kind' in ref) return this.entityToInputPeer(ref as CachedEntity);
    if (typeof ref === 'bigint') return this.toInputPeer(ref);
    const s = ref.trim();
    if (s === 'me' || s === 'self') return tl('inputPeerSelf', {});
    const cached = this.client.entityCache.resolve(s);
    if (cached && !this.needsAccessHash(cached)) return this.entityToInputPeer(cached);
    const username = s.startsWith('@') ? s.slice(1) : s;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(username)) {
      throw new Error(`cannot resolve peer: ${s}`);
    }
    const result = await this.client.invoke<TLObject>(
      tlMethod('contacts.resolveUsername', { username }),
    );
    this.client.entityCache.update(result.args.users, result.args.chats);
    const after = this.client.entityCache.resolve(username);
    if (after && after.accessHash !== 0n) return this.entityToInputPeer(after);
    throw new Error(`resolved ${s} but no access hash is available (private chat?)`);
  }

  /** Send a text message; returns the raw `Updates` result object. */
  async sendMessage(
    ref: string | bigint | CachedEntity | TLObject,
    message: string | FormattedText | TgFormatLike,
    options: SendMessageOptions = {},
  ): Promise<TLObject> {
    const peer = await this.resolvePeer(ref);
    const mode = options.parseMode ?? this.client.parseModeDefault;
    const formatted = toSendable(message, typeof message === 'string' ? mode : 'none');
    const entities = options.entities ?? formatted.entities;
    const args: Record<string, unknown> = {
      peer,
      message: formatted.text,
      random_id: randomLong(),
      no_webpage: options.linkPreview === false ? true : undefined,
      silent: options.silent === true ? true : undefined,
    };
    if (entities && entityCount(entities) > 0) args.entities = entities;
    if (options.replyTo !== undefined) {
      args.reply_to = tl('inputReplyToMessage', { reply_to_msg_id: options.replyTo });
    }
    const result = await this.client.invoke<TLObject>(tlMethod('messages.sendMessage', args));
    this.client.entityCache.update(result.args.users, result.args.chats);
    return result;
  }

  /** Fetch recent messages of a chat (newest first). */
  async getHistory(
    ref: string | bigint | CachedEntity | TLObject,
    options: { limit?: number; offsetId?: number } = {},
  ): Promise<TLObject[]> {
    const peer = await this.resolvePeer(ref);
    const result = await this.client.invoke<TLObject>(
      tlMethod('messages.getHistory', {
        peer,
        offset_id: options.offsetId ?? 0,
        offset_date: 0,
        add_offset: 0,
        limit: options.limit ?? 20,
        max_id: 0,
        min_id: 0,
        hash: 0n,
      }),
    );
    this.client.entityCache.update(result.args.users, result.args.chats);
    return (result.args.messages as TLObject[]) ?? [];
  }

  /** Fetch dialogs (also warms the entity cache for later peer resolution). */
  async getDialogs(limit = 20): Promise<TLObject[]> {
    const result = await this.client.invoke<TLObject>(
      tlMethod('messages.getDialogs', {
        offset_date: 0,
        offset_id: 0,
        offset_peer: tl('inputPeerEmpty', {}),
        limit,
        hash: 0n,
      }),
    );
    this.client.entityCache.update(result.args.users, result.args.chats);
    return (result.args.dialogs as TLObject[]) ?? [];
  }
}

function entityCount(entities: TLObject[] | undefined): number {
  return Array.isArray(entities) ? entities.length : 0;
}
