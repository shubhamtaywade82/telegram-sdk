/**
 * RPC layer: invokes TL methods over an authorized connection and dispatches
 * responses, errors, containers and updates.
 *
 * @module
 */

import { TLReader } from './binary.js';
import { parseResult, parseTLObject, registry, serializeTLObject, TLObject, type TLDescriptor } from './tl/index.js';
import { packEncryptedMessage, parseEncryptedMessage } from './mtproto/message.js';
import type { MTProtoSession } from './mtproto/session.js';
import type { MTProtoConnection } from './mtproto/connection.js';

/**
 * `rpc_result#f35c6d01 req_msg_id:long result:Object = RpcResult` (core.tl).
 * Pinned by tests/core-protocol.test.ts against src/tl/core.tl.
 */
export const RPC_RESULT_ID = 0xf35c6d01;
/**
 * `msg_container#73f1f8dc messages:vector<message> = MessageContainer` (core.tl).
 * Pinned by tests/core-protocol.test.ts against src/tl/core.tl.
 */
export const MSG_CONTAINER_ID = 0x73f1f8dc;
/** `rpc_error#2144ca19 error_code:int error_message:string = RpcError` (core.tl). */
export const RPC_ERROR_ID = 0x2144ca19;

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

  /** Target DC for *_MIGRATE_X errors, else null. */
  migrateDc(): number | null {
    const m = /^(?:PHONE|NETWORK|USER)_MIGRATE_(\d+)$/.exec(this.telegramMessage);
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
  /** Serialized-ready method object, kept for transparent resends. */
  methodObj: TLObject | null;
  /** Raw body when the method was wrapped (invokeWithLayer); resendable as-is. */
  body: Uint8Array;
  /** Declared result type of the method (drives parseResult). */
  resultType: string;
  timeoutMs: number;
  /** Resends performed so far (salt rotations, bounded). */
  resends: number;
}

/** Sends TL methods and matches responses by msg_id. */
export class MTProtoInvoker {
  private pending = new Map<bigint, PendingRequest>();
  private running = false;
  private static readonly MAX_RESENDS = 2;

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
    this.failPending(new Error('invoker stopped'));
  }

  /** Invoke a TL method and await its result (parsed per its declared type). */
  invoke<T = unknown>(method: TLObject): Promise<T> {
    const desc = registry.methodByName(method.name);
    const body = serializeTLObject(method).toBuffer();
    return this.invokeSerialized<T>(method.name, body, desc?.type ?? 'Object', method);
  }

  /**
   * Invoke an already-serialized method body (used for invokeWithLayer /
   * initConnection wrapping, where the body is built by hand).
   */
  invokeSerialized<T = unknown>(
    methodName: string,
    body: Uint8Array,
    resultType = 'Object',
    methodObj: TLObject | null = null,
  ): Promise<T> {
    if (!this.session.authKey) {
      return Promise.reject(new Error('invoke requires an authorized session (auth key)'));
    }
    return this.registerAndSend(methodName, body, resultType, methodObj) as Promise<T>;
  }

  private registerAndSend(
    methodName: string,
    body: Uint8Array,
    resultType: string,
    methodObj: TLObject | null,
    resends = 0,
  ): Promise<unknown> {
    // the msg_id is generated first so the pending entry can be registered
    // before the packet hits the wire (race-safe)
    const msgId = this.session.nextMsgId();
    const packet = packEncryptedMessage(this.session, body, true, msgId);
    const timeoutMs = this.options.timeoutMs ?? 30000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(msgId);
        if (pending) {
          this.pending.delete(msgId);
          reject(new Error(`timeout invoking ${methodName}`));
        }
      }, timeoutMs);
      this.pending.set(msgId, {
        resolve,
        reject,
        timer,
        method: methodName,
        methodObj,
        body,
        resultType,
        timeoutMs,
        resends,
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
        // transport lost: fail every pending invoke promptly instead of
        // letting each run into its own timeout
        this.failPending(err instanceof Error ? err : new Error(String(err)));
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
      this.pending.delete(reqMsgId);
      clearTimeout(pending.timer);

      // An rpc_error is a bare constructor regardless of the declared type;
      // peek before choosing the parser (the result may also be gzip_packed).
      const save = r.pos;
      const resultId = r.readUint();
      r.pos = save;
      if (resultId === RPC_ERROR_ID) {
        const err = parseTLObject(r);
        pending.reject(
          new TelegramRpcError(err.args.error_code as number, err.args.error_message as string),
        );
        return;
      }
      // parse through the method's declared result type: bare Vector results
      // (users.getUsers and friends) are only parseable this way
      const result = parseResult(r, pending.resultType);
      if (result instanceof TLObject && result.name === 'rpc_error') {
        pending.reject(
          new TelegramRpcError(result.args.error_code as number, result.args.error_message as string),
        );
        return;
      }
      pending.resolve(result);
      return;
    }

    const obj = parseTLObject(new TLReader(body));
    if (obj.name === 'bad_msg_notification' || obj.name === 'bad_server_salt') {
      const badId = obj.args.bad_msg_id as bigint;
      const pending = this.pending.get(badId);
      if (!pending) return;
      this.pending.delete(badId);
      clearTimeout(pending.timer);
      if (obj.name === 'bad_server_salt') {
        // adopt the rotated salt immediately, then transparently resend
        this.session.serverSalt = obj.args.new_server_salt as bigint;
        if (pending.resends < MTProtoInvoker.MAX_RESENDS) {
          this.registerAndSend(
            pending.method,
            pending.body,
            pending.resultType,
            pending.methodObj,
            pending.resends + 1,
          ).then(pending.resolve, pending.reject);
          return;
        }
        pending.reject(
          new Error(
            `bad_server_salt persisted after ${MTProtoInvoker.MAX_RESENDS} resends for ${pending.method}`,
          ),
        );
        return;
      }
      pending.reject(new Error(`bad_msg_notification (code ${obj.args.error_code}) for ${pending.method}`));
      return;
    }
    if (obj.name === 'new_session_created') {
      // salt rotations ride along with new sessions; keep it current
      this.session.serverSalt = obj.args.server_salt as bigint;
      // fall through: applications may still want to see the update
    }
    if (obj.name === 'msgs_ack') return;
    this.onUpdate?.(obj);
  }

  private failPending(err: Error): void {
    for (const [msgId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(msgId);
      pending.reject(new Error(`${err.message} (${pending.method})`));
    }
  }
}

/** Resolve the declared result type of a method name (helper for wrappers). */
export function resultTypeOf(methodName: string): string {
  const desc: TLDescriptor | undefined = registry.methodByName(methodName);
  return desc?.type ?? 'Object';
}
