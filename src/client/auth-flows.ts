/**
 * Login flows: user (phone code + optional 2FA SRP password) and bot tokens.
 * Handles DC migration errors (PHONE/NETWORK/USER_MIGRATE_X) transparently.
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

/** Target DC of a *_MIGRATE_X error, else null. */
export function migrateTarget(err: unknown): number | null {
  return err instanceof TelegramRpcError ? err.migrateDc() : null;
}

/** Log in as a user; returns the `user` object. */
export async function loginUser(client: TelegramClient, cbs: UserLoginCallbacks): Promise<TLObject> {
  const { apiId, apiHash } = client.options;
  const phone = (await cbs.phone()).trim();

  // --- sendCode (with DC migration retries) --------------------------------
  let sent: TLObject | null = null;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      sent = await client.invoke<TLObject>(
        tlMethod('auth.sendCode', {
          phone_number: phone,
          api_id: apiId,
          api_hash: apiHash,
          settings: tl('codeSettings', {}),
        }),
      );
    } catch (err) {
      const dc = migrateTarget(err);
      if (dc === null || attempt === 2) throw err;
      await client.switchDc(dc); // PHONE_MIGRATE_X / NETWORK_MIGRATE_X
    }
  }
  if (!sent) throw new Error('auth.sendCode failed');
  const phoneCodeHash = sent.args.phone_code_hash as string;
  const code = (await cbs.code()).trim();

  // --- signIn (2FA + USER_MIGRATE_X) ----------------------------------------
  let auth: TLObject | null = null;
  for (let attempt = 0; attempt < 3 && !auth; attempt++) {
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
      if (needsPassword) {
        if (!cbs.password) throw err;
        auth = await check2FaPassword(client, await cbs.password());
        continue;
      }
      const dc = migrateTarget(err);
      if (dc === null || attempt === 2) throw err;
      await client.switchDc(dc); // USER_MIGRATE_X
    }
  }
  if (!auth) throw new Error('auth.signIn failed');

  const user = auth.args.user as TLObject;
  client.me = user;
  client.entityCache.update(user);
  return user;
}

async function check2FaPassword(client: TelegramClient, password: string): Promise<TLObject> {
  const pw = await client.invoke<TLObject>(tlMethod('account.getPassword', {}));
  // current_algo is the KDF paired with srp_B / srp_id (flags.2);
  // new_algo carries fresh salts for SETTING a new password and is not
  // usable for login.
  const algoObj = pw.args.current_algo as TLObject | undefined;
  if (!algoObj || algoObj.name !== 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow') {
    throw new Error(`unsupported 2FA algorithm: ${algoObj?.name ?? 'none'}`);
  }
  const srpB = pw.args.srp_B as Uint8Array | undefined;
  const srpId = pw.args.srp_id as bigint | undefined;
  if (!srpB || srpId === undefined) {
    throw new Error('account has no SRP state (is a password really set?)');
  }
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
  let auth: TLObject | null = null;
  for (let attempt = 0; attempt < 3 && !auth; attempt++) {
    try {
      auth = await client.invoke<TLObject>(
        tlMethod('auth.importBotAuthorization', {
          flags: 0,
          api_id: client.options.apiId,
          api_hash: client.options.apiHash,
          bot_auth_token: token,
        }),
      );
    } catch (err) {
      const dc = migrateTarget(err);
      if (dc === null || attempt === 2) throw err;
      await client.switchDc(dc);
    }
  }
  if (!auth) throw new Error('auth.importBotAuthorization failed');
  const user = auth.args.user as TLObject;
  client.me = user;
  client.entityCache.update(user);
  return user;
}
