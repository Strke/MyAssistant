import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ACCESS_METHODS,
  type AccessMethod,
  ASSET_KINDS,
  ASSET_STATUSES,
  type Asset,
  type AssetAccess,
  type AssetAccessInput,
  type AssetInput,
  type AssetKind,
  type AssetStatus,
  SECRET_KINDS,
  type SecretKind,
} from "./types";

const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_ADDRESSES = 20;
const MAX_TAGS = 30;
const MAX_ACCESS = 30;

interface AssetFile {
  version: 1;
  assets: Asset[];
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueStrings(values: string[] | undefined, max: number, field: string): string[] {
  if (!values) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    if (result.length >= max) {
      throw new Error(`${field} supports at most ${max} entries.`);
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!ASSET_ID_PATTERN.test(id)) {
    throw new Error(
      "Asset id must start with a letter or digit and contain only lowercase letters, digits, dot, underscore or hyphen.",
    );
  }
  return id;
}

function normalizeKind(value: string | undefined): AssetKind {
  if (!value) {
    return "server";
  }
  if (!ASSET_KINDS.includes(value as AssetKind)) {
    throw new Error(`Invalid asset kind "${value}". Use one of: ${ASSET_KINDS.join(", ")}.`);
  }
  return value as AssetKind;
}

function normalizeStatus(value: string | undefined): AssetStatus {
  if (!value) {
    return "active";
  }
  if (!ASSET_STATUSES.includes(value as AssetStatus)) {
    throw new Error(`Invalid asset status "${value}". Use one of: ${ASSET_STATUSES.join(", ")}.`);
  }
  return value as AssetStatus;
}

function normalizeSecretKind(value: string | undefined): SecretKind | undefined {
  if (!value) {
    return undefined;
  }
  if (!SECRET_KINDS.includes(value as SecretKind)) {
    throw new Error(`Invalid secret kind "${value}". Use one of: ${SECRET_KINDS.join(", ")}.`);
  }
  return value as SecretKind;
}

function normalizeAccess(
  input: AssetAccessInput,
  index: number,
  defaultHost: string | undefined,
  usedIds: Set<string>,
): AssetAccess {
  if (!ACCESS_METHODS.includes(input.method)) {
    throw new Error(
      `Invalid access method "${input.method}". Use one of: ${ACCESS_METHODS.join(", ")}.`,
    );
  }
  const method = input.method as AccessMethod;
  let id = clean(input.id) ?? method;
  if (usedIds.has(id)) {
    id = `${method}-${index + 1}`;
  }
  while (usedIds.has(id)) {
    id = `${id}-${index + 1}`;
  }
  usedIds.add(id);

  if (
    input.port !== undefined &&
    (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65_535)
  ) {
    throw new Error(`Invalid port for access "${id}": ${input.port}.`);
  }
  const secretName = clean(input.secretName);
  if (secretName && !SECRET_NAME_PATTERN.test(secretName)) {
    throw new Error(
      `Invalid secret name for access "${id}". Use letters, digits, dot, underscore or hyphen.`,
    );
  }

  return {
    id,
    method,
    host: clean(input.host) ?? defaultHost,
    port: input.port,
    username: clean(input.username),
    secretName,
    secretKind: normalizeSecretKind(input.secretKind),
    command: clean(input.command),
    notes: clean(input.notes),
  };
}

function normalizeAsset(input: AssetInput, existing: Asset | undefined, now: number): Asset {
  const id = normalizeId(input.id);
  const name = clean(input.name);
  if (!name) {
    throw new Error("Asset name is required.");
  }
  const addresses = uniqueStrings(input.addresses, MAX_ADDRESSES, "addresses");
  const tags = uniqueStrings(input.tags, MAX_TAGS, "tags");
  const accessInputs = input.access ?? [];
  if (accessInputs.length > MAX_ACCESS) {
    throw new Error(`access supports at most ${MAX_ACCESS} entries.`);
  }
  const usedAccessIds = new Set<string>();
  const access = accessInputs.map((entry, index) =>
    normalizeAccess(entry, index, addresses[0], usedAccessIds),
  );

  return {
    id,
    name,
    kind: normalizeKind(input.kind),
    status: normalizeStatus(input.status),
    addresses,
    tags,
    os: clean(input.os),
    location: clean(input.location),
    notes: clean(input.notes),
    access,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function isAsset(value: unknown): value is Asset {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.kind === "string" &&
    typeof record.status === "string" &&
    Array.isArray(record.addresses) &&
    Array.isArray(record.tags) &&
    Array.isArray(record.access) &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

export class JsonAssetStore {
  private readonly path: string;
  private readonly now: () => number;
  private assets = new Map<string, Asset>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  async init(): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
    });
  }

  async list(): Promise<Asset[]> {
    return this.exclusive(async () => {
      await this.load();
      return [...this.assets.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((asset) => structuredClone(asset));
    });
  }

  async get(id: string): Promise<Asset | undefined> {
    const key = id.trim().toLowerCase();
    return this.exclusive(async () => {
      await this.load();
      const asset = this.assets.get(key);
      return asset ? structuredClone(asset) : undefined;
    });
  }

  async save(input: AssetInput): Promise<Asset> {
    const key = input.id.trim().toLowerCase();
    return this.exclusive(async () => {
      await this.load();
      const existing = this.assets.get(key);
      const asset = normalizeAsset(input, existing, this.now());
      this.assets.set(asset.id, asset);
      await this.writeFile();
      return structuredClone(asset);
    });
  }

  async delete(id: string): Promise<boolean> {
    const key = id.trim().toLowerCase();
    return this.exclusive(async () => {
      await this.load();
      if (!this.assets.delete(key)) {
        return false;
      }
      await this.writeFile();
      return true;
    });
  }

  private async load(): Promise<void> {
    const file = await this.readFile();
    this.assets = new Map(file.assets.map((asset) => [asset.id, asset]));
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readFile(): Promise<AssetFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (!raw.trim()) {
        return { version: 1, assets: [] };
      }
      const parsed = JSON.parse(raw) as Partial<AssetFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.assets)) {
        throw new Error(`Unsupported asset file format: ${this.path}`);
      }
      if (!parsed.assets.every(isAsset)) {
        throw new Error(`Asset file contains invalid entries: ${this.path}`);
      }
      return { version: 1, assets: parsed.assets };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, assets: [] };
      }
      throw error;
    }
  }

  private async writeFile(): Promise<void> {
    await mkdir(dirname(resolve(this.path)), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    const assets = [...this.assets.values()].sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(temp, `${JSON.stringify({ version: 1, assets }, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
    await chmod(this.path, 0o600);
  }
}
