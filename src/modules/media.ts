/**
 * Media: chunked upload (saveBigFilePart -> inputFile), sending photos,
 * and downloading photos/documents by file location.
 *
 * @module
 */

import { tl, tlMethod, type TLObject } from '../tl/index.js';
import { randomLong } from '../utils.js';
import { toSendable, type FormattedText, type ParseMode, type TgFormatLike } from './formatting.js';
import type { CachedEntity, TelegramClient } from '../client/telegram-client.js';

export interface SendMediaOptions {
  parseMode?: ParseMode;
  replyTo?: number;
}

/** File upload/download + media messages. */
export class Media {
  constructor(private readonly client: TelegramClient) {}

  /** Upload bytes in 512 KiB parts; returns an `inputFile`. */
  async uploadFile(data: Uint8Array, name = 'file.bin'): Promise<TLObject> {
    const fileId = randomLong();
    const partSize = 512 * 1024;
    const totalParts = Math.max(1, Math.ceil(data.length / partSize));
    for (let part = 0; part < totalParts; part++) {
      const chunk = data.subarray(part * partSize, Math.min((part + 1) * partSize, data.length));
      const ok = await this.client.invoke<TLObject>(
        tlMethod('upload.saveBigFilePart', {
          file_id: fileId,
          file_part: part,
          file_total_parts: totalParts,
          bytes: chunk,
        }),
      );
      if (ok.name !== 'boolTrue') {
        throw new Error(`upload.saveBigFilePart ${part} failed (${ok.name})`);
      }
    }
    return tl('inputFile', { id: fileId, parts: totalParts, name, md5_checksum: '' });
  }

  /** Upload a photo and send it (optionally with a formatted caption). */
  async sendPhoto(
    ref: string | bigint | CachedEntity | TLObject,
    file: { data: Uint8Array; name?: string },
    caption?: string | FormattedText | TgFormatLike,
    options: SendMediaOptions = {},
  ): Promise<TLObject> {
    const peer = await this.client.messaging.resolvePeer(ref);
    const uploaded = await this.uploadFile(file.data, file.name ?? 'photo.jpg');
    const formatted =
      caption === undefined
        ? { text: '', entities: [] as TLObject[] }
        : toSendable(caption, typeof caption === 'string' ? (options.parseMode ?? this.client.parseModeDefault) : 'none');
    const args: Record<string, unknown> = {
      peer,
      random_id: randomLong(),
      media: tl('inputMediaUploadedPhoto', { file: uploaded }),
      message: formatted.text,
    };
    if (formatted.entities.length > 0) args.entities = formatted.entities;
    if (options.replyTo !== undefined) {
      args.reply_to = tl('inputReplyToMessage', { reply_to_msg_id: options.replyTo });
    }
    const result = await this.client.invoke<TLObject>(tlMethod('messages.sendMedia', args));
    this.client.entityCache.update(result.args.users, result.args.chats);
    return result;
  }

  /** Download the photo of a `message` (messageMediaPhoto). */
  async downloadPhoto(message: TLObject): Promise<Uint8Array> {
    const media = message.args.media as TLObject | undefined;
    if (!media || media.name !== 'messageMediaPhoto') {
      throw new Error(`message has no photo (media=${media?.name ?? 'none'})`);
    }
    const photo = media.args.photo as TLObject;
    if (photo.name !== 'photo') throw new Error(`unsupported photo type ${photo.name}`);
    return this.downloadByLocation(
      tl('inputPhotoFileLocation', {
        id: photo.args.id as bigint,
        access_hash: photo.args.access_hash as bigint,
        file_reference: photo.args.file_reference as Uint8Array,
        thumb_size: '',
      }),
    );
  }

  /** Download the document of a `message` (messageMediaDocument). */
  async downloadDocument(message: TLObject): Promise<Uint8Array> {
    const media = message.args.media as TLObject | undefined;
    if (!media) throw new Error('message has no media');
    const doc = media.args.document as TLObject | undefined;
    if (media.name !== 'messageMediaDocument' || !doc || doc.name !== 'document') {
      throw new Error(`unsupported document media (media=${media.name}, doc=${doc?.name})`);
    }
    return this.downloadByLocation(
      tl('inputDocumentFileLocation', {
        id: doc.args.id as bigint,
        access_hash: doc.args.access_hash as bigint,
        file_reference: doc.args.file_reference as Uint8Array,
        thumb_size: '',
      }),
    );
  }

  private async downloadByLocation(location: TLObject): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const limit = 1024 * 1024;
    for (let offset = 0; ; offset += limit) {
      const res = await this.client.invoke<TLObject>(
        tlMethod('upload.getFile', { location, offset, limit }),
      );
      if (res.name !== 'upload.file') throw new Error(`unexpected upload.getFile result: ${res.name}`);
      const bytes = res.args.bytes as Uint8Array;
      if (bytes.length === 0) break;
      chunks.push(bytes);
      if (bytes.length < limit) break;
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}
