import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import { argon2id } from "@noble/hashes/argon2.js";
import type { MasterKeyProvider } from "./types";

export const MASTER_KEY_BYTES = 32;
const ARGON2_SALT_BYTES = 16;

export interface KeychainProviderOptions {
  service: string;
  account: string;
}

export interface PassphraseProviderOptions {
  passphrase: string;
  saltPath: string;
}

export interface DefaultProviderOptions {
  service: string;
  account: string;
  saltPath?: string;
  env?: NodeJS.ProcessEnv;
}

function createKey(): Uint8Array {
  return new Uint8Array(randomBytes(MASTER_KEY_BYTES));
}

function decodeBase64Key(encoded: string | undefined): Uint8Array | undefined {
  if (!encoded) {
    return undefined;
  }
  try {
    const key = new Uint8Array(Buffer.from(encoded.trim(), "base64"));
    return key.length === MASTER_KEY_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

export function createStaticKeyProvider(initial: Uint8Array): MasterKeyProvider {
  let key = new Uint8Array(initial);
  return {
    async getKey() {
      return new Uint8Array(key);
    },
    async setKey(next: Uint8Array) {
      key = new Uint8Array(next);
    },
    async deleteKey() {
      key = new Uint8Array(MASTER_KEY_BYTES);
    },
  };
}

export function createEnvKeyProvider(env: NodeJS.ProcessEnv = process.env): MasterKeyProvider {
  return {
    async getKey() {
      return decodeBase64Key(env.VAULT_MASTER_KEY);
    },
    async setKey() {
      throw new Error(
        "Cannot persist a master key to the environment. Set VAULT_MASTER_KEY manually or use the OS keychain.",
      );
    },
  };
}

export function createKeychainKeyProvider(options: KeychainProviderOptions): MasterKeyProvider {
  const entry = new AsyncEntry(options.service, options.account);
  return {
    async getKey() {
      const secret = await entry.getSecret();
      if (!secret || secret.length !== MASTER_KEY_BYTES) {
        return undefined;
      }
      return Uint8Array.from(secret);
    },
    async setKey(key: Uint8Array) {
      await entry.setSecret(key);
    },
    async deleteKey() {
      await entry.deletePassword();
    },
  };
}

export function createPassphraseKeyProvider(options: PassphraseProviderOptions): MasterKeyProvider {
  return {
    async getKey() {
      let salt: Uint8Array;
      try {
        salt = new Uint8Array(await readFile(options.saltPath));
      } catch {
        salt = new Uint8Array(randomBytes(ARGON2_SALT_BYTES));
        await mkdir(dirname(resolve(options.saltPath)), { recursive: true });
        await writeFile(options.saltPath, salt, { mode: 0o600 });
        await chmod(options.saltPath, 0o600);
      }
      return argon2id(options.passphrase, salt, {
        t: 3,
        m: 65536,
        p: 1,
        dkLen: MASTER_KEY_BYTES,
      });
    },
  };
}

export function createDefaultKeyProvider(options: DefaultProviderOptions): MasterKeyProvider {
  const env = options.env ?? process.env;
  if (env.VAULT_MASTER_KEY) {
    return createEnvKeyProvider(env);
  }
  if (env.VAULT_PASSPHRASE && options.saltPath) {
    return createPassphraseKeyProvider({
      passphrase: env.VAULT_PASSPHRASE,
      saltPath: options.saltPath,
    });
  }
  if (process.platform === "darwin") {
    return createKeychainKeyProvider({ service: options.service, account: options.account });
  }
  return createEnvKeyProvider(env);
}

export function generateMasterKey(): Uint8Array {
  return createKey();
}
