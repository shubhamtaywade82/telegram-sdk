import type { ResponseParameters } from './types.js';

export class TelegramError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class TelegramApiError extends TelegramError {
  readonly errorCode: number;
  readonly parameters: ResponseParameters;
  readonly httpStatus: number;

  constructor(input: { errorCode: number; description: string; parameters?: ResponseParameters; httpStatus: number }) {
    super(input.description);
    this.errorCode = input.errorCode;
    this.parameters = input.parameters ?? {};
    this.httpStatus = input.httpStatus;
  }

  get retryAfter(): number | undefined { return this.parameters.retry_after; }
  get migrateToChatId(): number | undefined { return this.parameters.migrate_to_chat_id; }
}

export class TelegramNetworkError extends TelegramError {}
export class TelegramTimeoutError extends TelegramNetworkError {}
export class TelegramRequestAbortedError extends TelegramNetworkError {}
