/**
 * Updates: initialization (updates.getState) and catch-up polling
 * (updates.getDifference), plus real-time dispatch of pushed updates.
 *
 * @module
 */

import { tlMethod, type TLObject } from '../tl/index.js';
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

  /** Incoming messages (new user/channel messages). */
  onMessage: ((message: TLObject) => void) | null = null;
  /** All other updates. */
  onUpdate: ((update: TLObject) => void) | null = null;
  /** Polling errors. */
  onError: ((err: Error) => void) | null = null;

  constructor(private readonly client: TelegramClient) {}

  /** Dispatch one pushed update (wired automatically by TelegramClient). */
  handleUpdate(update: TLObject): void {
    if (update.name === 'updateNewMessage' || update.name === 'updateNewChannelMessage') {
      const msg = update.args.message as TLObject | undefined;
      if (msg) {
        this.client.entityCache.update(update.args.users, update.args.chats);
        this.onMessage?.(msg);
      }
      return;
    }
    if (update.name === 'updatesTooLong') {
      void this.catchUp();
      return;
    }
    this.client.entityCache.update(update.args.users, update.args.chats);
    this.onUpdate?.(update);
  }

  /** Start polling (initial catch-up + interval). */
  async start(pollIntervalMs = 5000): Promise<void> {
    this.stop();
    await this.catchUp();
    this.timer = setInterval(() => {
      void this.catchUp();
    }, pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
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
        return;
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
