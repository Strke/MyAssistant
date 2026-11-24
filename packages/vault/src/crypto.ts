import { randomBytes } from "node:crypto";
import { gcm } from "@noble/ciphers/aes.js";

const NONCE_BYTES = 12;

export interface EncryptedSecret {
  nonce: string;
  data: string;
}

function additionalData(name: string): Uint8Array {
  return new TextEncoder().encode(`myassistant:vault:${name}`);
}

export function encryptSecret(key: Uint8Array, name: string, value: string): EncryptedSecret {
  const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
  const cipher = gcm(key, nonce, additionalData(name));
  const encrypted = cipher.encrypt(new TextEncoder().encode(value));
  return {
    nonce: Buffer.from(nonce).toString("base64"),
    data: Buffer.from(encrypted).toString("base64"),
  };
}

export function decryptSecret(key: Uint8Array, name: string, secret: EncryptedSecret): string {
  const nonce = new Uint8Array(Buffer.from(secret.nonce, "base64"));
  const data = new Uint8Array(Buffer.from(secret.data, "base64"));
  const cipher = gcm(key, nonce, additionalData(name));
  return new TextDecoder().decode(cipher.decrypt(data));
}
