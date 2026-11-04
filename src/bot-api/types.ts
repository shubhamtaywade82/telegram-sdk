/** Structural shape accepted from telegram-format without adding a package dependency. */
export interface FormattedText {
  readonly text: string;
  readonly entities?: readonly MessageEntity[];
}

export type MessageEntityType =
  | 'mention' | 'hashtag' | 'cashtag' | 'bot_command' | 'url' | 'email' | 'phone_number'
  | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'spoiler' | 'blockquote'
  | 'expandable_blockquote' | 'code' | 'pre' | 'text_link' | 'text_mention' | 'custom_emoji'
  | 'date_time';

export interface MessageEntity {
  type: MessageEntityType | (string & {});
  offset: number;
  length: number;
  url?: string;
  user?: User;
  language?: string;
  custom_emoji_id?: string;
  unix_time?: number;
  date_time_format?: string;
}

export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: true;
  added_to_attachment_menu?: true;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface Chat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface Message {
  message_id: number;
  message_thread_id?: number;
  from?: User;
  sender_chat?: Chat;
  date: number;
  chat: Chat;
  text?: string;
  entities?: MessageEntity[];
  caption?: string;
  caption_entities?: MessageEntity[];
  [field: string]: unknown;
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  edited_channel_post?: Message;
  callback_query?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface File {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface ResponseParameters {
  migrate_to_chat_id?: number;
  retry_after?: number;
}

export interface ApiResponse<T> { ok: true; result: T; description?: string }
export interface ApiErrorResponse { ok: false; error_code: number; description: string; parameters?: ResponseParameters }

export interface InputFile {
  data: Blob | Uint8Array | ArrayBuffer;
  fileName: string;
  contentType?: string;
}

export type ChatId = number | string;

export interface SendMessageParams {
  chat_id: ChatId;
  text: string | FormattedText;
  parse_mode?: string;
  entities?: readonly MessageEntity[];
  link_preview_options?: Record<string, unknown>;
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  disable_notification?: boolean;
  protect_content?: boolean;
  reply_parameters?: Record<string, unknown>;
  reply_markup?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface EditMessageTextParams {
  chat_id?: ChatId;
  message_id?: number;
  inline_message_id?: string;
  text: string | FormattedText;
  parse_mode?: string;
  entities?: readonly MessageEntity[];
  link_preview_options?: Record<string, unknown>;
  reply_markup?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface SendDocumentParams {
  chat_id: ChatId;
  document: string | InputFile;
  caption?: string;
  parse_mode?: string;
  caption_entities?: readonly MessageEntity[];
  [field: string]: unknown;
}

export interface SendPhotoParams {
  chat_id: ChatId;
  photo: string | InputFile;
  caption?: string;
  parse_mode?: string;
  caption_entities?: readonly MessageEntity[];
  [field: string]: unknown;
}

export interface GetUpdatesParams {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface TelegramBotApiClientOptions {
  token: string;
  apiBaseUrl?: string;
  fileBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  defaultHeaders?: HeadersInit;
}

export interface PollUpdatesOptions extends RequestOptions {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}
