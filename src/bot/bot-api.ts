/**
 * A Bot-API-compatible facade over the MTProto core: log in with a bot
 * token and use `getMe` / `sendMessage` / `sendPhoto` / `getUpdates`
 * with Bot-API-shaped results.
 *
 * @module
 */

import { loginBot } from '../client/auth-flows.js';
import { TelegramClient } from '../client/telegram-client.js';
import type { CachedEntity } from '../client/telegram-client.js';
import type { FormattedText, ParseMode, TgFormatLike } from '../modules/formatting.js';
import { toSendable } from '../modules/formatting.js';
import type { TLObject } from '../tl/index.js';

export interface BotApiInit {
  apiId: number;
  apiHash: string;
  dcId?: number;
}

export interface BotApiUser {
  id: string;
  is_bot: true;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface BotApiChat {
  id: string;
  kind: 'user' | 'chat' | 'channel';
}

export interface BotApiMessage {
  message_id: number;
  date?: number;
  text?: string;
  chat: BotApiChat;
}

export interface BotApiUpdate {
  update_id: number;
  message?: BotApiMessage;
}

/** Bot-API-style options (snake_case, mirroring the official Bot API). */
export interface BotSendMessageOptions {
  parse_mode?: ParseMode;
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
}

/** Bot-API-like surface implemented over MTProto. */
export class BotApi {
  private updateQueue: BotApiUpdate[] = [];
  private nextUpdateId = 1;

  /** Wrap an already-connected (and bot-logged-in) client. */
  constructor(readonly client: TelegramClient) {
    this.client.updates.onMessage = (msg) => {
      const shaped = shapeMessage(msg);
      if (shaped) this.updateQueue.push({ update_id: this.nextUpdateId++, message: shaped });
    };
  }

  /** Create a client, connect, and log in with a bot token. */
  static async fromToken(token: string, init: BotApiInit): Promise<BotApi> {
    const client = new TelegramClient({
      apiId: init.apiId,
      apiHash: init.apiHash,
      dcId: init.dcId,
      parseModeDefault: 'html',
    });
    await client.connect();
    await loginBot(client, token);
    return new BotApi(client);
  }

  /** The bot's own user. */
  getMe(): BotApiUser {
    const me = this.client.me;
    if (!me) throw new Error('not logged in');
    return {
      id: (me.args.id as bigint).toString(),
      is_bot: true,
      first_name: (me.args.first_name as string) ?? '',
      last_name: me.args.last_name as string | undefined,
      username: me.args.username as string | undefined,
    };
  }

  /** Send a text message; returns a Bot-API-shaped message. */
  async sendMessage(
    chat: string | bigint | CachedEntity | TLObject,
    text: string | FormattedText | TgFormatLike,
    options: BotSendMessageOptions = {},
  ): Promise<BotApiMessage> {
    const result = await this.client.messaging.sendMessage(chat, text, {
      parseMode: options.parse_mode,
      replyTo: options.reply_to_message_id,
      linkPreview: options.disable_web_page_preview !== true,
    });
    const sent = extractSentMessage(result);
    const shaped = shapeMessage(sent);
    if (!shaped) throw new Error('could not extract the sent message from the response');
    return shaped;
  }

  /** Upload and send a photo (optionally with a caption). */
  async sendPhoto(
    chat: string | bigint | CachedEntity | TLObject,
    photo: { data: Uint8Array; name?: string },
    caption?: string | FormattedText | TgFormatLike,
    options: { parse_mode?: ParseMode; reply_to_message_id?: number } = {},
  ): Promise<BotApiMessage> {
    const result = await this.client.media.sendPhoto(chat, photo, caption, {
      parseMode: options.parse_mode,
      replyTo: options.reply_to_message_id,
    });
    const sent = extractSentMessage(result);
    const shaped = shapeMessage(sent);
    if (!shaped) throw new Error('could not extract the sent message from the response');
    return shaped;
  }

  /** Start update polling (needed before getUpdates returns anything). */
  async start(pollIntervalMs = 5000): Promise<void> {
    await this.client.updates.start(pollIntervalMs);
  }

  /** Drain queued updates (Bot-API style). */
  getUpdates(): BotApiUpdate[] {
    const out = this.updateQueue;
    this.updateQueue = [];
    return out;
  }
}

function extractSentMessage(result: TLObject): TLObject | null {
  const updates = result.args.updates as TLObject[] | undefined;
  if (Array.isArray(updates)) {
    for (const u of updates) {
      if (u.name === 'updateNewMessage' || u.name === 'updateNewChannelMessage') {
        return (u.args.message as TLObject) ?? null;
      }
    }
  }
  if (result.name === 'updateShortSentMessage') return result;
  return null;
}

function shapeMessage(msg: TLObject | null): BotApiMessage | null {
  if (!msg) return null;
  const peer = msg.args.peer_id as TLObject | undefined;
  let chat: BotApiChat | null = null;
  if (peer?.name === 'peerUser') chat = { id: `user:${(peer.args.user_id as bigint).toString()}`, kind: 'user' };
  else if (peer?.name === 'peerChat') chat = { id: `chat:${(peer.args.chat_id as bigint).toString()}`, kind: 'chat' };
  else if (peer?.name === 'peerChannel') chat = { id: `channel:${(peer.args.channel_id as bigint).toString()}`, kind: 'channel' };
  if (!chat) return null;
  return {
    message_id: msg.args.id as number,
    date: msg.args.date as number | undefined,
    text: (msg.args.message as string | undefined) ?? '',
    chat,
  };
}
