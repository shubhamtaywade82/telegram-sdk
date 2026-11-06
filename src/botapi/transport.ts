import type { BotApiMethodMap, BotApiMethodName } from './generated/methods.js';
import { BotApiHttpError } from './errors.js';
import { type InputFile, isInputFile } from './input-file.js';

export interface BotApiClientOptions {
  /** Bot token from @BotFather. Never logged or echoed in errors. */
  readonly token: string;
  /** Defaults to https://api.telegram.org. A local Bot API server URL works too. */
  readonly baseUrl?: string;
  /** Injected for tests or proxies. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-request timeout. `getUpdates` long polls extend it automatically. Default 30 000 ms. */
  readonly timeoutMs?: number;
  /** Retries for rate limits (429) and, for read-only methods, transient failures. Default 3. */
  readonly maxRetries?: number;
  /** Longest `retry_after` the client will sleep for before failing. Default 60 s. */
  readonly maxRetryAfterSeconds?: number;
  /** Injected sleep, so retry behaviour can be tested without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly userAgent?: string;
}

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_AFTER_S = 60;

/** Methods safe to repeat after an ambiguous failure: every `get*` method is read-only. */
const isReadOnly = (method: string): boolean => method.startsWith('get');

interface Envelope {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

interface Attachment {
  readonly field: string;
  readonly value: InputFile;
}

/**
 * Transport for the Bot API over HTTPS. Generated methods on `BotApiHttpClient` delegate here.
 *
 * Retries: 429 is retried after `retry_after` (the server states the request was not processed).
 * Transient 5xx and network failures are retried only for read-only (`get*`) methods. Send
 * methods are never repeated after an ambiguous failure, because the message may already have
 * been delivered; the caller must decide whether to resend.
 */
export abstract class BotApiTransport {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxRetryAfterS: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #userAgent: string;

  constructor(options: BotApiClientOptions) {
    if (!options.token) throw new TypeError('BotApiClient: a bot token is required');
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#maxRetryAfterS = options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_S;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#userAgent = options.userAgent ?? 'telegram-sdk (Bot API)';
  }

  /** Typed invocation used by the generated methods. */
  protected call<M extends BotApiMethodName>(
    method: M,
    params: BotApiMethodMap[M]['params'],
  ): Promise<BotApiMethodMap[M]['result']> {
    return this.request(method, params as Record<string, unknown>) as Promise<BotApiMethodMap[M]['result']>;
  }

  /**
   * Untyped invocation for methods this SDK does not yet know (for example, a newer Bot API
   * release). Parameters are sent as-is; the result is returned without validation.
   */
  callRaw<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.request(method, params) as Promise<T>;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.#baseUrl}/bot${this.#token}/${method}`;
    const encoded = encodeParams(params);
    const timeout = timeoutFor(method, params, this.#timeoutMs);
    const readOnly = isReadOnly(method);

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        const body = encoded.kind === 'json' ? encoded.body : encoded.build();
        const headers: Record<string, string> = { 'user-agent': this.#userAgent };
        if (encoded.kind === 'json') headers['content-type'] = 'application/json';
        res = await this.#fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(timeout) });
      } catch (err) {
        if (readOnly && attempt < this.#maxRetries) {
          await this.#backoff(attempt);
          continue;
        }
        throw networkError(method, err);
      }

      const payload = await parseEnvelope(res);
      if (payload?.ok === true) return payload.result;

      const failure = describeFailure(res.status, payload);
      if (failure.errorCode === 429 && attempt < this.#maxRetries) {
        const waitS = failure.retryAfter ?? 1;
        if (waitS > this.#maxRetryAfterS) {
          throw new BotApiHttpError(method, `rate limited; retry_after ${waitS}s exceeds the ${this.#maxRetryAfterS}s cap`, failure);
        }
        await this.#sleep(waitS * 1000);
        continue;
      }
      if (readOnly && res.status >= 500 && attempt < this.#maxRetries) {
        await this.#backoff(attempt);
        continue;
      }
      throw new BotApiHttpError(method, `${failure.description} (HTTP ${res.status})`, failure);
    }
  }

  #backoff(attempt: number): Promise<void> {
    return this.#sleep(Math.min(250 * 2 ** attempt, 5_000));
  }
}

type Encoded =
  | { readonly kind: 'json'; readonly body: string }
  | { readonly kind: 'multipart'; readonly build: () => FormData };

/** Chooses JSON when no file is attached, multipart/form-data otherwise. */
export function encodeParams(params: Record<string, unknown>): Encoded {
  const { json, files } = extractFiles(params);
  if (files.length === 0) return { kind: 'json', body: JSON.stringify(json) };
  return {
    kind: 'multipart',
    build: () => {
      const form = new FormData();
      for (const [key, value] of Object.entries(json)) {
        form.append(key, typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
      }
      for (const file of files) {
        const { blob, filename } = toBlob(file.value);
        form.append(file.field, blob, filename);
      }
      return form;
    },
  };
}

/**
 * Replaces each file with a reference. A top-level file is sent under its parameter name.
 * A file nested inside an object or array (for example `InputMediaPhoto.media`) is sent as a
 * separate part named `fileN` and referenced as `attach://fileN`.
 */
export function extractFiles(params: Record<string, unknown>): {
  json: Record<string, unknown>;
  files: Attachment[];
} {
  const files: Attachment[] = [];
  let counter = 0;
  const walk = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    if (isInputFile(value)) {
      const field = `file${counter++}`;
      files.push({ field, value });
      return `attach://${field}`;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const w = walk(v);
        if (w !== undefined) out[k] = w;
      }
      return out;
    }
    return value;
  };

  const json: Record<string, unknown> = {};
  const top: Attachment[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (isInputFile(value)) {
      top.push({ field: key, value });
      continue;
    }
    json[key] = walk(value);
  }
  return { json, files: [...top, ...files] };
}

function toBlob(file: InputFile): { blob: Blob; filename: string } {
  if (file instanceof Blob) {
    const named = file as Blob & { name?: unknown };
    return { blob: file, filename: typeof named.name === 'string' ? named.name : 'upload' };
  }
  if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
    return { blob: new Blob([file]), filename: 'upload' };
  }
  const source = file.data;
  const blob =
    source instanceof Blob
      ? source
      : new Blob([source], file.contentType ? { type: file.contentType } : undefined);
  return { blob, filename: file.filename };
}

function timeoutFor(method: string, params: Record<string, unknown>, base: number): number {
  if (method === 'getUpdates' && typeof params['timeout'] === 'number') {
    return Math.max(base, (params['timeout'] + 10) * 1000);
  }
  return base;
}

async function parseEnvelope(res: Response): Promise<Envelope | undefined> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === 'object' ? (parsed as Envelope) : undefined;
  } catch {
    return undefined;
  }
}

function describeFailure(status: number, payload: Envelope | undefined) {
  return {
    errorCode: payload?.error_code ?? status,
    description: payload?.description ?? 'response was not a Bot API envelope',
    retryAfter: payload?.parameters?.retry_after,
    migrateToChatId: payload?.parameters?.migrate_to_chat_id,
  };
}

/** Reports the failure class only. The raw error can contain the request URL, which holds the token. */
function networkError(method: string, err: unknown): BotApiHttpError {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  const name = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network';
  const code = typeof e?.code === 'string' ? e.code : typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
  return new BotApiHttpError(method, `${name} failure${code ? ` (${code})` : ''}; the request may or may not have been processed`, {
    cause: { name: typeof e?.name === 'string' ? e.name : 'unknown', ...(code ? { code } : {}) },
  });
}
