/**
 * Updates: initialization (updates.getState) and catch-up polling
 * (updates.getDifference), plus real-time dispatch of pushed updates
 * (containers, short forms included).
 *
 * @module
 */

import { tl, tlMethod, type TLObject } from '../tl/index.js';
import type { TelegramClient } from '../client/telegram-client.js';

interface UpdateState {
  pts: number;
  qts: number;
  date: number;
  seq: number;
}

/** Receives messages and updates. */
export class Updates {
  private state: UpdateState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private starting = false;
  private stopped = true;

  /** Incoming messages (new user/channel messages and short forms). */
  onMessage: ((message: TLObject) => void) | null = null;
  /** All other updates. */
  onUpdate: ((update: TLObject) => void) | null = null;
  /** Polling errors. */
  onError: ((err: Error) => void) | null = null;

  constructor(private readonly client: TelegramClient) {}

  /** Dispatch one pushed update (wired automatically by TelegramClient). */
  handleUpdate(update: TLObject): void {
    // containers carry their own users/chats - warm the cache first
    if (update.name === 'updates' || update.name === 'updatesCombined') {
      this.client.entityCache.update(update.args.users, update.args.chats);
      for (const u of (update.args.updates as TLObject[]) ?? []) this.handleUpdate(u);
      return;
    }
    if (update.name === 'updateNewMessage' || update.name === 'updateNewChannelMessage') {
      const msg = update.args.message as TLObject | undefined;
      if (msg) {
        this.client.entityCache.update(update.args.users, update.args.chats);
        this.onMessage?.(msg);
      }
      return;
    }
    // short forms are messages without the full container; synthesize a
    // message object so onMessage sees one shape
    if (update.name === 'updateShortMessage' || update.name === 'updateShortChatMessage') {
      this.onMessage?.(shortToMessage(update));
      return;
    }
    if (update.name === 'updatesTooLong') {
      void this.catchUp();
      return;
    }
    this.client.entityCache.update(update.args.users, update.args.chats);
    this.onUpdate?.(update);
  }

  /** Start polling (initial catch-up + interval). Concurrent calls coalesce. */
  async start(pollIntervalMs = 5000): Promise<void> {
    if (this.starting) return; // the in-flight start() wins
    this.stop();
    this.stopped = false;
    this.starting = true;
    try {
      await this.catchUp();
      if (!this.stopped) {
        this.timer = setInterval(() => {
          void this.catchUp();
        }, pollIntervalMs);
        this.timer.unref?.();
      }
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async catchUp(): Promise<void> {
    try {
      if (!this.state) {
        const s = await this.client.invoke<TLObject>(tlMethod('updates.getState', {}));
        this.state = {
          pts: s.args.pts as number,
          qts: s.args.qts as number,
          date: s.args.date as number,
          seq: s.args.seq as number,
        };
        // fall through: fetch the difference immediately instead of
        // delaying the first poll by a full interval
      }
      const diff = await this.client.invoke<TLObject>(
        tlMethod('updates.getDifference', {
          pts: this.state.pts,
          date: this.state.date,
          qts: this.state.qts,
        }),
      );
      if (diff.name === 'updates.differenceEmpty') return;
      if (diff.name === 'updates.differenceTooLong') {
        this.state.pts = diff.args.pts as number;
        return;
      }
      for (const msg of (diff.args.new_messages as TLObject[]) ?? []) this.onMessage?.(msg);
      for (const u of (diff.args.other_updates as TLObject[]) ?? []) this.handleUpdate(u);
      this.client.entityCache.update(diff.args.chats, diff.args.users);
      const newState = (diff.args.state ?? diff.args.intermediate_state) as TLObject | undefined;
      if (newState) {
        this.state = {
          pts: newState.args.pts as number,
          qts: newState.args.qts as number,
          date: newState.args.date as number,
          seq: newState.args.seq as number,
        };
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** Build a `message`-shaped object from an updateShort*Message. */
function shortToMessage(update: TLObject): TLObject {
  const base = {
    id: update.args.id,
    date: update.args.date,
    message: update.args.message,
    out: update.args.out === true,
  };
  if (update.name === 'updateShortChatMessage') {
    // updateShortChatMessage: from_id:long + chat_id:long
    return tl('message', {
      ...base,
      peer_id: tl('peerChat', { chat_id: update.args.chat_id }),
      from_id: tl('peerUser', { user_id: update.args.from_id }),
    });
  }
  // updateShortMessage: user_id:long (the conversation partner)
  return tl('message', {
    ...base,
    peer_id: tl('peerUser', { user_id: update.args.user_id }),
  });
}
