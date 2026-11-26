export const ASSET_KINDS = [
  "server",
  "vm",
  "nas",
  "router",
  "switch",
  "laptop",
  "desktop",
  "phone",
  "tablet",
  "container",
  "cloud",
  "other",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STATUSES = ["active", "retired"] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ACCESS_METHODS = [
  "ssh",
  "rdp",
  "vnc",
  "http",
  "https",
  "smb",
  "serial",
  "other",
] as const;

export type AccessMethod = (typeof ACCESS_METHODS)[number];

export const SECRET_KINDS = ["ssh_key", "password", "token", "certificate", "other"] as const;

export type SecretKind = (typeof SECRET_KINDS)[number];

export interface AssetAccess {
  id: string;
  method: AccessMethod;
  host?: string;
  port?: number;
  username?: string;
  secretName?: string;
  secretKind?: SecretKind;
  execEnabled?: boolean;
  command?: string;
  notes?: string;
}

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  status: AssetStatus;
  addresses: string[];
  tags: string[];
  os?: string;
  location?: string;
  notes?: string;
  access: AssetAccess[];
  createdAt: number;
  updatedAt: number;
}

export interface AssetAccessInput {
  id?: string;
  method: AccessMethod;
  host?: string;
  port?: number;
  username?: string;
  secretName?: string;
  secretKind?: SecretKind;
  execEnabled?: boolean;
  command?: string;
  notes?: string;
}

export interface AssetInput {
  id: string;
  name: string;
  kind?: AssetKind;
  status?: AssetStatus;
  addresses?: string[];
  tags?: string[];
  os?: string;
  location?: string;
  notes?: string;
  access?: AssetAccessInput[];
}

export interface AssetStore {
  list(): Promise<Asset[]>;
  get(id: string): Promise<Asset | undefined>;
  save(input: AssetInput): Promise<Asset>;
  delete(id: string): Promise<boolean>;
}

export interface AssetStoreOptions {
  path: string;
  now?: () => number;
}
