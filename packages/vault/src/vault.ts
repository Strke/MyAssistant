import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { decryptSecret, encryptSecret } from "./crypto";
import { MASTER_KEY_BYTES } from "./providers";
import type {
  MasterKeyProvider,
  SecretMetadata,
  SecretResolver,
  SecretStore,
  VaultAuditEvent,
  VaultAuditSink,
  VaultOptions,
} from "./types";

interface VaultEntryFile {
  nonce: string;
  data: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultEntryFile>;
}

const PLACEHOLDER_PATTERN = /\$\{vault:([A-Za-z0-9_.-]+)\}/g;

export class Vault implements SecretStore, SecretResolver {
  private readonly path: string;
  private readonly keyProvider: MasterKeyProvider;
  private readonly autoLockMs: number;
  private readonly initialize: boolean;
  private readonly audit?: VaultAuditSink;
  private readonly now: () => number;

  private key: Uint8Array | undefined;
  private lockTimer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: VaultOptions) {
    this.path = options.path;
    this.keyProvider = options.keyProvider;
    this.autoLockMs = Math.max(0, (options.autoLockMinutes ?? 15) * 60_000);
    this.initialize = options.initialize ?? true;
    this.audit = options.audit;
    this.now = options.now ?? Date.now;
  }

  async unlock(): Promise<void> {
    await this.exclusive(async () => {
      await this.ensureLoaded();
    });
  }

  lock(): void {
    if (this.key) {
      this.key.fill(0);
      this.key = undefined;
    }
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = undefined;
    }
    this.emit({ action: "lock", at: this.now(), success: true });
  }

  async has(name: string): Promise<boolean> {
    return this.exclusive(async () => {
      const file = await this.readVaultFile();
      return Boolean(file.entries[name]);
    });
  }

  async get(name: string): Promise<string | undefined> {
    return this.exclusive(async () => {
      const key = await this.ensureLoaded();
      const file = await this.readVaultFile();
      const entry = file.entries[name];
      if (!entry) {
        this.emit({ action: "get", name, at: this.now(), success: false, error: "not_found" });
        return undefined;
      }

      try {
        const value = decryptSecret(key, name, { nonce: entry.nonce, data: entry.data });
        this.emit({ action: "get", name, at: this.now(), success: true });
        return value;
      } catch {
        this.emit({ action: "get", name, at: this.now(), success: false, error: "decrypt_failed" });
        throw new Error(`Failed to decrypt secret "${name}".`);
      }
    });
  }

  async set(name: string, value: string, description?: string): Promise<void> {
    await this.exclusive(async () => {
      const key = await this.ensureLoaded();
      const file = await this.readVaultFile();
      const existing = file.entries[name];
      const timestamp = this.now();
      const encrypted = encryptSecret(key, name, value);
      file.entries[name] = {
        ...encrypted,
        description: description ?? existing?.description,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await this.writeVaultFile(file);
      this.emit({ action: "set", name, at: timestamp, success: true });
    });
  }

  async delete(name: string): Promise<boolean> {
    return this.exclusive(async () => {
      const file = await this.readVaultFile();
      if (!file.entries[name]) {
        this.emit({ action: "delete", name, at: this.now(), success: false, error: "not_found" });
        return false;
      }
      delete file.entries[name];
      await this.writeVaultFile(file);
      this.emit({ action: "delete", name, at: this.now(), success: true });
      return true;
    });
  }

  async list(): Promise<SecretMetadata[]> {
    return this.exclusive(async () => {
      const file = await this.readVaultFile();
      this.emit({ action: "list", at: this.now(), success: true });
      return Object.entries(file.entries)
        .map(([name, entry]) => ({
          name,
          description: entry.description,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async resolvePlaceholders(input: string): Promise<string> {
    const names = new Set<string>();
    for (const match of input.matchAll(PLACEHOLDER_PATTERN)) {
      if (match[1]) {
        names.add(match[1]);
      }
    }

    let output = input;
    for (const name of names) {
      const value = await this.get(name);
      if (value === undefined) {
        throw new Error(`Vault secret not found: ${name}`);
      }
      output = output.replaceAll(`\${vault:${name}}`, value);
    }
    return output;
  }

  async close(): Promise<void> {
    this.lock();
  }

  private async ensureLoaded(): Promise<Uint8Array> {
    if (this.key) {
      this.touch();
      return this.key;
    }

    let key = await this.keyProvider.getKey();
    if (!key) {
      if (!this.initialize || !this.keyProvider.setKey) {
        throw new Error(
          "Vault master key not found. Unlock the OS keychain or set VAULT_MASTER_KEY.",
        );
      }
      key = new Uint8Array(randomBytes(MASTER_KEY_BYTES));
      await this.keyProvider.setKey(key);
    }

    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error("Invalid vault master key length.");
    }

    this.key = key;
    this.touch();
    this.emit({ action: "unlock", at: this.now(), success: true });
    return key;
  }

  private touch(): void {
    if (this.autoLockMs <= 0) {
      return;
    }
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
    }
    this.lockTimer = setTimeout(() => this.lock(), this.autoLockMs);
    this.lockTimer.unref?.();
  }

  private async readVaultFile(): Promise<VaultFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as VaultFile;
      if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
        throw new Error(`Unsupported vault file format: ${this.path}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  private async writeVaultFile(file: VaultFile): Promise<void> {
    await mkdir(dirname(resolve(this.path)), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.path);
    await chmod(this.path, 0o600);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private emit(event: VaultAuditEvent): void {
    if (!this.audit) {
      return;
    }
    void Promise.resolve(this.audit(event)).catch(() => undefined);
  }
}
