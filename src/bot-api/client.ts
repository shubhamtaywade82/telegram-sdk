import {
  TelegramApiError,
  TelegramNetworkError,
  TelegramRequestAbortedError,
  TelegramTimeoutError,
} from './errors.js';
import type {
  ApiErrorResponse,
  ApiResponse,
  EditMessageTextParams,
  File,
  FormattedText,
  GetUpdatesParams,
  InputFile,
  Message,
  PollUpdatesOptions,
  RequestOptions,
  SendDocumentParams,
  SendMessageParams,
  SendPhotoParams,
  TelegramBotApiClientOptions,
  Update,
  User,
} from './types.js';

const DEFAULT_API = 'https://api.telegram.org';
const DEFAULT_FILE = 'https://api.telegram.org/file';
const DEFAULT_TIMEOUT = 30_000;
type Params = Record<string, unknown>;

function baseUrl(value: string, name: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new TypeError(name + ' must use HTTPS (HTTP is allowed for localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(name + ' must not contain credentials, query parameters, or fragments');
  }
  return url.toString().replace(/\/$/, '');
}

function isInputFile(value: unknown): value is InputFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<InputFile>;
  return typeof file.fileName === 'string' &&
    (file.data instanceof Blob || file.data instanceof ArrayBuffer || file.data instanceof Uint8Array);
}

function asBlob(file: InputFile): Blob {
  if (file.data instanceof Blob && !file.contentType) return file.data;
  return new Blob([file.data], file.contentType ? { type: file.contentType } : undefined);
}

function hasUpload(value: unknown, seen = new WeakSet<object>()): boolean {
  if (isInputFile(value)) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasUpload(item, seen));
  return Object.values(value).some((item) => hasUpload(item, seen));
}

function toFormData(params: Params): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (isInputFile(value)) form.append(key, asBlob(value), value.fileName);
    else if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      form.append(key, JSON.stringify(value));
    } else form.append(key, String(value));
  }
  return form;
}

function normalizeTextParams<T extends { text: string | FormattedText; entities?: readonly unknown[] }>(params: T): Params {
  const { text, entities, ...rest } = params;
  if (typeof text === 'string') return { ...rest, text, ...(entities ? { entities } : {}) };
  if (entities && text.entities) {
    throw new TypeError('Pass entities either inside FormattedText or as entities, not both');
  }
  const resolved = entities ?? text.entities;
  return { ...rest, text: text.text, ...(resolved ? { entities: resolved } : {}) };
}

function apiError(value: unknown, status: number): TelegramApiError | undefined {
  if (typeof value !== 'object' || value === null || (value as Partial<ApiErrorResponse>).ok !== false) return undefined;
  const body = value as Partial<ApiErrorResponse>;
  return new TelegramApiError({
    errorCode: typeof body.error_code === 'number' ? body.error_code : status,
    description: typeof body.description === 'string' ? body.description : 'Telegram Bot API request failed',
    ...(body.parameters ? { parameters: body.parameters } : {}),
    httpStatus: status,
  });
}

function safeCause(error: unknown, token: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.split(token).join('[REDACTED]'));
}

function encodeFilePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Fetch-based Bot API client. It does not implement MTProto or user login. */
export class TelegramBotApiClient {
  readonly #token: string;
  readonly #apiBase: string;
  readonly #fileBase: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #headers: Headers;
  #polling = false;

  constructor(options: TelegramBotApiClientOptions) {
    if (!options.token || !/^\d+:[A-Za-z0-9_-]+$/.test(options.token)) {
      throw new TypeError('A valid Telegram bot token is required');
    }
    this.#token = options.token;
    this.#apiBase = baseUrl(options.apiBaseUrl ?? DEFAULT_API, 'apiBaseUrl');
    this.#fileBase = baseUrl(options.fileBaseUrl ?? DEFAULT_FILE, 'fileBaseUrl');
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') throw new TypeError('A Fetch API implementation is required');
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a non-negative safe integer');
    }
    this.#headers = new Headers(options.defaultHeaders);
  }

  /** Generic escape hatch for Bot API methods not yet represented by wrappers. */
  async call<T>(method: string, params: Params = {}, options: RequestOptions = {}): Promise<T> {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) throw new TypeError('Invalid Telegram Bot API method name');
    const url = this.#apiBase + '/bot' + this.#token + '/' + method;
    const multipart = hasUpload(params);
    const headers = new Headers(this.#headers);
    let body: BodyInit;
    if (multipart) {
      // Fetch must set the multipart boundary; a caller-supplied JSON header is wrong here.
      headers.delete('content-type');
      body = toFormData(params);
    } else {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(params);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: this.#signal(options),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new TelegramTimeoutError('Telegram request timed out', { cause: safeCause(error, this.#token) });
      }
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new TelegramRequestAbortedError('Telegram request was aborted', { cause: safeCause(error, this.#token) });
      }
      throw new TelegramNetworkError('Network error while calling the Telegram Bot API', {
        cause: safeCause(error, this.#token),
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TelegramNetworkError('Telegram Bot API returned non-JSON (HTTP ' + response.status + ')', {
        cause: safeCause(error, this.#token),
      });
    }

    const failure = apiError(payload, response.status);
    if (failure) throw failure;
    if (!response.ok) throw new TelegramNetworkError('Telegram Bot API returned HTTP ' + response.status);
    if (typeof payload !== 'object' || payload === null || (payload as Partial<ApiResponse<T>>).ok !== true) {
      throw new TelegramNetworkError('Telegram Bot API returned an invalid response envelope');
    }
    return (payload as ApiResponse<T>).result;
  }

  getMe(options?: RequestOptions): Promise<User> {
    return this.call<User>('getMe', {}, options);
  }

  sendMessage(params: SendMessageParams, options?: RequestOptions): Promise<Message> {
    return this.call<Message>('sendMessage', normalizeTextParams(params), options);
  }

  editMessageText(params: EditMessageTextParams, options?: RequestOptions): Promise<Message | true> {
    return this.call<Message | true>('editMessageText', normalizeTextParams(params), options);
  }

  deleteMessage(params: { chat_id: number | string; message_id: number }, options?: RequestOptions): Promise<boolean> {
    return this.call<boolean>('deleteMessage', params, options);
  }

  getUpdates(params: GetUpdatesParams = {}, options?: RequestOptions): Promise<Update[]> {
    return this.call<Update[]>('getUpdates', params as unknown as Params, options);
  }

  sendDocument(params: SendDocumentParams, options?: RequestOptions): Promise<Message> {
    return this.call<Message>('sendDocument', params as unknown as Params, options);
  }

  sendPhoto(params: SendPhotoParams, options?: RequestOptions): Promise<Message> {
    return this.call<Message>('sendPhoto', params as unknown as Params, options);
  }

  getFile(fileId: string, options?: RequestOptions): Promise<File> {
    return this.call<File>('getFile', { file_id: fileId }, options);
  }

  async downloadFile(filePath: string, options: RequestOptions = {}): Promise<Uint8Array> {
    if (!filePath || filePath.startsWith('/') || filePath.split('/').some((part) => part === '..')) {
      throw new TypeError('filePath must be a relative Telegram file path');
    }
    let response: Response;
    try {
      response = await this.#fetch(
        this.#fileBase + '/bot' + this.#token + '/' + encodeFilePath(filePath),
        { method: 'GET', signal: this.#signal(options), headers: this.#headers },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new TelegramTimeoutError('Telegram file download timed out', { cause: safeCause(error, this.#token) });
      }
      if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new TelegramRequestAbortedError('Telegram file download was aborted', { cause: safeCause(error, this.#token) });
      }
      throw new TelegramNetworkError('Network error while downloading a Telegram file', {
        cause: safeCause(error, this.#token),
      });
    }
    if (!response.ok) throw new TelegramNetworkError('Telegram file download returned HTTP ' + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Advances the update offset only after the user handler has completed successfully. */
  async pollUpdates(
    handler: (update: Update) => void | Promise<void>,
    options: PollUpdatesOptions = {},
  ): Promise<void> {
    if (this.#polling) throw new Error('This client already has an active pollUpdates loop');
    this.#polling = true;
    let offset = options.offset;
    try {
      while (!options.signal?.aborted) {
        const longPollSeconds = options.timeout ?? 30;
        let updates: Update[];
        try {
          updates = await this.getUpdates({
            ...(offset === undefined ? {} : { offset }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            timeout: longPollSeconds,
            ...(options.allowed_updates ? { allowed_updates: options.allowed_updates } : {}),
          }, {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: options.timeoutMs ?? (longPollSeconds + 5) * 1000,
          });
        } catch (error) {
          if (options.signal?.aborted) break;
          throw error;
        }
        for (const update of updates) {
          if (options.signal?.aborted) break;
          await handler(update);
          offset = update.update_id + 1;
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  #signal(options: RequestOptions): AbortSignal {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a non-negative safe integer');
    }
    if (options.signal && timeoutMs > 0) return AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    if (options.signal) return options.signal;
    if (timeoutMs > 0) return AbortSignal.timeout(timeoutMs);
    return new AbortController().signal;
  }
}

export function createTelegramBotApiClient(options: TelegramBotApiClientOptions): TelegramBotApiClient {
  return new TelegramBotApiClient(options);
}
