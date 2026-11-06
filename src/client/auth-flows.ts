/**
 * Login flows: user (phone code + optional 2FA SRP password) and bot tokens.
 *
 * @module
 */

import { computeSrpCheck } from '../crypto/srp.js';
import { tl, tlMethod, type TLObject } from '../tl/index.js';
import { TelegramRpcError } from '../rpc.js';
import type { TelegramClient } from './telegram-client.js';

export interface UserLoginCallbacks {
  phone: () => Promise<string>;
  code: () => Promise<string>;
  /** Asked for only when the account has 2FA enabled. */
  password?: () => Promise<string>;
}

/** Log in as a user; returns the `user` object. */
export async function loginUser(client: TelegramClient, cbs: UserLoginCallbacks): Promise<TLObject> {
  const { apiId, apiHash } = client.options;
  const phone = (await cbs.phone()).trim();
  const sent = await client.invoke<TLObject>(
    tlMethod('auth.sendCode', {
      phone_number: phone,
      api_id: apiId,
      api_hash: apiHash,
      settings: tl('codeSettings', {}),
    }),
  );
  const phoneCodeHash = sent.args.phone_code_hash as string;
  const code = (await cbs.code()).trim();

  let auth: TLObject;
  try {
    auth = await client.invoke<TLObject>(
      tlMethod('auth.signIn', {
        phone_number: phone,
        phone_code_hash: phoneCodeHash,
        phone_code: code,
      }),
    );
  } catch (err) {
    const needsPassword =
      err instanceof TelegramRpcError && err.telegramMessage === 'SESSION_PASSWORD_NEEDED';
    if (!cbs.password || !needsPassword) throw err;
    auth = await check2FaPassword(client, (await cbs.password()));
  }

  const user = auth.args.user as TLObject;
  client.me = user;
  client.entityCache.update(user);
  return user;
}

async function check2FaPassword(client: TelegramClient, password: string): Promise<TLObject> {
  const pw = await client.invoke<TLObject>(tlMethod('account.getPassword', {}));
  const algoObj = (pw.args.new_algo ?? pw.args.login_algo) as TLObject | undefined;
  if (!algoObj || algoObj.name !== 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow') {
    throw new Error(`unsupported 2FA algorithm: ${algoObj?.name ?? 'none'}`);
  }
  const srpB = pw.args.srp_B as Uint8Array;
  if (!srpB) throw new Error('account has no SRP state (is a password really set?)');
  const srpId = pw.args.srp_id as bigint;
  const check = computeSrpCheck(
    password,
    {
      g: algoObj.args.g as number,
      p: algoObj.args.p as Uint8Array,
      salt1: algoObj.args.salt1 as Uint8Array,
      salt2: algoObj.args.salt2 as Uint8Array,
    },
    { srpId, srpB },
  );
  return await client.invoke<TLObject>(
    tlMethod('auth.checkPassword', {
      password: tl('inputCheckPasswordSRP', { srp_id: check.srpId, A: check.A, M1: check.M1 }),
    }),
  );
}

/** Log in as a bot using a token from @BotFather. */
export async function loginBot(client: TelegramClient, token: string): Promise<TLObject> {
  const auth = await client.invoke<TLObject>(
    tlMethod('auth.importBotAuthorization', {
      flags: 0,
      api_id: client.options.apiId,
      api_hash: client.options.apiHash,
      bot_auth_token: token,
    }),
  );
  const user = auth.args.user as TLObject;
  client.me = user;
  client.entityCache.update(user);
  return user;
}
