export interface SecretMetadata {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecretStore {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string, description?: string): Promise<void>;
  delete(name: string): Promise<boolean>;
  list(): Promise<SecretMetadata[]>;
}

export interface SecretResolver {
  resolvePlaceholders(input: string): Promise<string>;
}

export type VaultAction = "unlock" | "lock" | "get" | "set" | "delete" | "list";

export interface VaultAuditEvent {
  action: VaultAction;
  name?: string;
  at: number;
  success: boolean;
  error?: string;
}

export type VaultAuditSink = (event: VaultAuditEvent) => void | Promise<void>;

export interface MasterKeyProvider {
  getKey(): Promise<Uint8Array | undefined>;
  setKey?(key: Uint8Array): Promise<void>;
  deleteKey?(): Promise<void>;
}

export interface VaultOptions {
  path: string;
  keyProvider: MasterKeyProvider;
  autoLockMinutes?: number;
  initialize?: boolean;
  audit?: VaultAuditSink;
  now?: () => number;
}
