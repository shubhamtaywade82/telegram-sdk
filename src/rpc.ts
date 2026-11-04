/**
 * RPC layer: invokes TL methods over an authorized connection and dispatches
 * responses, errors, containers and updates.
 *
 * @module
 */

import { TLReader } from './binary.js';
import { parseTLObject, serializeTLObject, type TLObject } from './tl/index.js';
import { packEncryptedMessage, parseEncryptedMessage } from './mtproto/message.js';
import type { MTProtoSession } from './mtproto/session.js';
import type { MTProtoConnection } from './mtproto/connection.js';

/** `rpc_result#f35c6d0a` (core protocol constant). */
export const RPC_RESULT_ID = 0xf35c6d0a;
/** `msg_container#73f1f4dc` (core protocol constant). */
export const MSG_CONTAINER_ID = 0x73f1f4dc;

/** An `rpc_error` from the server. */
export class TelegramRpcError extends Error {
  constructor(
    readonly code: number,
    readonly telegramMessage: string,
  ) {
    super(`${telegramMessage} (code ${code})`);
    this.name = 'TelegramRpcError';
  }

  /** Seconds to wait for FLOOD_WAIT_* errors, else null. */
  waitSeconds(): number | null {
    const m = /^FLOOD_WAIT_(\d+)$/.exec(this.telegramMessage);
    return m ? Number(m[1]) : null;
  }
}

export interface InvokerOptions {
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** Sends TL methods and matches responses by msg_id. */
export class MTProtoInvoker {
  private pending = new Map<bigint, PendingRequest>();
  private running = false;

  /** Called for every object that is not a response or an ack (updates). */
  onUpdate: ((update: TLObject) => void) | null = null;
  /** Fatal parse/loop errors. */
  onError: ((err: Error) => void) | null = null;

  constructor(
    private readonly connection: MTProtoConnection,
    private readonly session: MTProtoSession,
    private readonly options: InvokerOptions = {},
  ) {}

  /** Start the read loop (after the auth key is in place). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.readLoop();
  }

  stop(): void {
    this.running = false;
    for (const [msgId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`invoker stopped (${pending.method})`));
      this.pending.delete(msgId);
    }
  }

  /** Invoke a TL method and await its result. */
  invoke<T = unknown>(method: TLObject): Promise<T> {
    if (!this.session.authKey) {
      return Promise.reject(new Error('invoke requires an authorized session (auth key)'));
    }
    const body = serializeTLObject(method).toBuffer();
    const msgId = this.session.nextMsgId();
    const packet = packEncryptedMessage(this.session, body, true, msgId);
    const timeoutMs = this.options.timeoutMs ?? 30000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(msgId);
        if (pending) {
          this.pending.delete(msgId);
          reject(new Error(`timeout invoking ${method.name}`));
        }
      }, timeoutMs);
      this.pending.set(msgId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method: method.name,
      });
      this.connection.send(packet);
    });
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      let payload: Uint8Array;
      try {
        payload = await this.connection.nextPayload(60000);
      } catch (err) {
        if (!this.running) return;
        if (err instanceof Error && err.message === 'payload timeout') continue;
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
        this.running = false;
        return;
      }
      try {
        const msg = parseEncryptedMessage(this.session, payload, 8);
        if (msg.salt !== this.session.serverSalt) this.session.serverSalt = msg.salt;
        this.handleBody(msg.body);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private handleBody(body: Uint8Array): void {
    const peek = new TLReader(body);
    const id = peek.readUint();

    if (id === MSG_CONTAINER_ID) {
      const r = new TLReader(body);
      r.readUint(); // constructor id
      const count = r.readInt();
      for (let i = 0; i < count; i++) {
        r.readLong(); // msg_id
        r.readUint(); // seq_no
        const len = r.readUint();
        this.handleBody(r.readRaw(len));
      }
      return;
    }

    if (id === RPC_RESULT_ID) {
      const r = new TLReader(body);
      r.readUint(); // constructor id
      const reqMsgId = r.readLong();
      const pending = this.pending.get(reqMsgId);
      if (!pending) return; // unknown or already timed out
      const result = parseTLObject(r);
      this.pending.delete(reqMsgId);
      clearTimeout(pending.timer);
      if (result.name === 'rpc_error') {
        pending.reject(
          new TelegramRpcError(result.args.error_code as number, result.args.error_message as string),
        );
        return;
      }
      pending.resolve(result);
      return;
    }

    const obj = parseTLObject(new TLReader(body));
    if (obj.name === 'bad_msg_notification') {
      const badId = obj.args.bad_msg_id as bigint;
      const pending = this.pending.get(badId);
      if (pending) {
        this.pending.delete(badId);
        clearTimeout(pending.timer);
        pending.reject(new Error(`bad_msg_notification (code ${obj.args.error_code}) for ${pending.method}`));
      }
      return;
    }
    if (obj.name === 'msgs_ack') return;
    this.onUpdate?.(obj);
  }
}
