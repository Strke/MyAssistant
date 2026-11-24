import { dirname, resolve } from "node:path";
import type { AppConfig } from "@myassistant/config";
import { createDefaultKeyProvider, createJsonlAuditLog, Vault } from "@myassistant/vault";

export function openVault(config: AppConfig): Vault {
  const keyProvider = createDefaultKeyProvider({
    service: config.vault.keychainService,
    account: config.vault.keychainAccount,
    saltPath: resolve(dirname(config.vault.path), "vault.salt"),
  });
  const audit = createJsonlAuditLog(resolve(dirname(config.vault.path), "vault-audit.log"));

  return new Vault({
    path: config.vault.path,
    keyProvider,
    autoLockMinutes: config.vault.autoLockMinutes,
    audit,
  });
}
