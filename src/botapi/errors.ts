/**
 * A Bot API call failed: Telegram returned `ok: false`, the response was not JSON,
 * or the transport failed. The bot token is never included in the message or fields.
 */
export class BotApiHttpError extends Error {
  readonly code = 'BOT_API_HTTP';
  /** Bot API method that failed, e.g. `sendMessage`. */
  readonly method: string;
  /** Telegram's `error_code`, or the HTTP status when no JSON envelope was returned. */
  readonly errorCode: number | undefined;
  /** Telegram's `description`, verbatim. */
  readonly description: string | undefined;
  /** `parameters.retry_after` in seconds, when Telegram rate-limited the call. */
  readonly retryAfter: number | undefined;
  /** `parameters.migrate_to_chat_id`, when the group was upgraded to a supergroup. */
  readonly migrateToChatId: number | undefined;

  constructor(
    method: string,
    message: string,
    details: {
      errorCode?: number | undefined;
      description?: string | undefined;
      retryAfter?: number | undefined;
      migrateToChatId?: number | undefined;
      cause?: { name?: string; code?: string } | undefined;
    } = {},
  ) {
    super(`Bot API ${method}: ${message}`, details.cause ? { cause: details.cause } : undefined);
    this.name = 'BotApiHttpError';
    this.method = method;
    this.errorCode = details.errorCode;
    this.description = details.description;
    this.retryAfter = details.retryAfter;
    this.migrateToChatId = details.migrateToChatId;
  }
}
