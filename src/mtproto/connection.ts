/**
 * TCP connection: binds a transport to a socket and delivers framed
 * MTProto payloads.
 *
 * @module
 */

import { Socket } from 'node:net';
import { createTransport, type Transport, type TransportName, TransportError } from './transports.js';

/** Production datacenters (host, IPv4). */
export const PRODUCTION_DCS: Readonly<Record<number, string>> = {
  1: '149.154.175.53',
  2: '149.154.167.51',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '91.108.56.130',
};

export interface ConnectionOptions {
  host: string;
  port?: number;
  dcId?: number;
  transport?: TransportName;
  connectTimeoutMs?: number;
}

/** A framed TCP connection to one Telegram datacenter. */
export class MTProtoConnection {
  readonly dcId: number;
  private readonly transport: Transport;
  private socket: Socket | null = null;
  private connected = false;
  private payloadQueue: Uint8Array[] = [];
  private waiters: Array<{ resolve: (p: Uint8Array) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  /** Set by higher layers; called on fatal connection errors. */
  onError: ((err: Error) => void) | null = null;
  /** Called when the socket closes. */
  onClose: (() => void) | null = null;

  constructor(private readonly options: ConnectionOptions) {
    this.dcId = options.dcId ?? 2;
    this.transport = createTransport(options.transport ?? 'intermediate');
  }

  /** Connect, send the transport hello, and start reading. */
  connect(): Promise<void> {
    const { host, port = 443, connectTimeoutMs = 15000 } = this.options;
    return new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      socket.setNoDelay(true);
      const fail = (err: Error): void => {
        this.failWaiters(err);
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`connect timeout to ${host}:${port}`)), connectTimeoutMs);
      socket.once('error', (err) => {
        clearTimeout(timer);
        if (!this.connected) {
          fail(err instanceof Error ? err : new Error(String(err)));
        } else {
          this.handleError(err instanceof Error ? err : new Error(String(err)));
        }
      });
      socket.connect(port, host, () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connected = true;
        socket.write(this.transport.hello());
        socket.on('data', (chunk) => {
          try {
            for (const payload of this.transport.feed(chunk)) this.deliver(payload);
          } catch (err) {
            this.handleError(err instanceof Error ? err : new Error(String(err)));
          }
        });
        socket.once('close', () => {
          this.connected = false;
          this.socket = null;
          this.failWaiters(new Error('connection closed'));
          this.onClose?.();
        });
        resolve();
      });
    });
  }

  /** Send one framed payload. */
  send(payload: Uint8Array): void {
    if (!this.socket || !this.connected) throw new Error('connection is not open');
    this.socket.write(this.transport.encode(payload));
  }

  /** Await the next payload (handshakes use this directly). */
  nextPayload(timeoutMs = 10000): Promise<Uint8Array> {
    const queued = this.payloadQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('payload timeout'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  private deliver(payload: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
    } else {
      this.payloadQueue.push(payload);
    }
  }

  private failWaiters(err: Error): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.length = 0;
    this.payloadQueue.length = 0;
  }

  private handleError(err: Error): void {
    if (err instanceof TransportError) {
      // keep the connection; surfaces through onError
      this.onError?.(err);
      return;
    }
    this.failWaiters(err);
    this.onError?.(err);
    this.socket?.destroy();
  }
}
