export { createJsonlAuditLog } from "./audit";
export { decryptSecret, encryptSecret } from "./crypto";
export type {
  DefaultProviderOptions,
  KeychainProviderOptions,
  PassphraseProviderOptions,
} from "./providers";
export {
  createDefaultKeyProvider,
  createEnvKeyProvider,
  createKeychainKeyProvider,
  createPassphraseKeyProvider,
  createStaticKeyProvider,
  generateMasterKey,
  MASTER_KEY_BYTES,
} from "./providers";
export type { VaultToolOptions } from "./tool";
export { createVaultTools } from "./tool";
export type {
  MasterKeyProvider,
  SecretMetadata,
  SecretResolver,
  SecretStore,
  VaultAction,
  VaultAuditEvent,
  VaultAuditSink,
  VaultOptions,
} from "./types";
export { Vault } from "./vault";
