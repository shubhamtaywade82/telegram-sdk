/**
 * mtproto-sdk - TypeScript SDK for Telegram's MTProto 2.0 client API.
 *
 * Importing this module registers the full generated Layer (232) schema -
 * both the API schema and the core MTProto service schema - so every
 * constructor and method of the layer is usable through the dynamic TL
 * layer (`tl`, `tlMethod`, `parseTLObject`, ...).
 *
 * @module
 */

import { registry } from './tl/index.js';
import { ALL_CONSTRUCTORS, ALL_METHODS } from './tl/schema-all.js';
import { ALL_CORE_CONSTRUCTORS, ALL_CORE_METHODS } from './tl/schema-core.js';

registry.register([...ALL_CORE_CONSTRUCTORS, ...ALL_CORE_METHODS, ...ALL_CONSTRUCTORS, ...ALL_METHODS]);

export * from './utils.js';
export * from './binary.js';
export * from './tl/index.js';
export { LAYER, ALL_CONSTRUCTORS, ALL_METHODS } from './tl/schema-all.js';
export { LAYER as CORE_LAYER, ALL_CORE_CONSTRUCTORS, ALL_CORE_METHODS } from './tl/schema-core.js';
export { tloToJson, jsonToTlo } from './tl/index.js';
export * from './crypto/ige.js';
export * from './crypto/rsa.js';
export { TELEGRAM_RSA_KEYS } from './crypto/rsa-keys.js';
export { computeSrpCheck } from './crypto/srp.js';
export type { SrpAlgo, SrpServerState, SrpCheck } from './crypto/srp.js';
export { checkDhParams, validateDhValue } from './crypto/dh.js';
export { factorizePQ, isProbablyPrime, gcdBigInt } from './crypto/math.js';
export * from './mtproto/transports.js';
export { MTProtoSession } from './mtproto/session.js';
export * from './mtproto/message.js';
export { MTProtoConnection, PRODUCTION_DCS } from './mtproto/connection.js';
export type { ConnectionOptions } from './mtproto/connection.js';
export { createAuthKey, AuthKeyError } from './mtproto/auth-key.js';
export type { AuthKeyResult, CreateAuthKeyOptions } from './mtproto/auth-key.js';
export * from './rpc.js';
export * from './client/telegram-client.js';
export * from './client/session-store.js';
export * from './client/auth-flows.js';
export * from './modules/formatting.js';
export { Messaging } from './modules/messaging.js';
export type { SendMessageOptions } from './modules/messaging.js';
export { Media } from './modules/media.js';
export type { SendMediaOptions } from './modules/media.js';
export { Updates } from './modules/updates.js';
export { BotApi } from './bot/bot-api.js';
export type { BotApiInit, BotApiUser, BotApiChat, BotApiMessage, BotApiUpdate, BotSendMessageOptions } from './bot/bot-api.js';
export * from './botapi/index.js';
