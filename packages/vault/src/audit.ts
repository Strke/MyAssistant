import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { VaultAuditEvent, VaultAuditSink } from "./types";

export function createJsonlAuditLog(path: string): VaultAuditSink {
  return async (event: VaultAuditEvent) => {
    await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  };
}
