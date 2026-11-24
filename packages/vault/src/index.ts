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
