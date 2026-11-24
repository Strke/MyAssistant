import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticKeyProvider } from "./providers";
import type { VaultAuditEvent, VaultAuditSink } from "./types";
import { Vault } from "./vault";

const masterKey = new Uint8Array(32).fill(7);

describe("Vault", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "myassistant-vault-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const createVault = (audit?: VaultAuditSink) =>
    new Vault({
      path: join(dir, "vault.enc"),
      keyProvider: createStaticKeyProvider(masterKey),
      autoLockMinutes: 0,
      audit,
    });

  it("stores, lists, reads and deletes secrets", async () => {
    const vault = createVault();
    try {
      await vault.set("github_token", "ghp_secret", "GitHub token");
      expect(await vault.has("github_token")).toBe(true);
      expect(await vault.get("github_token")).toBe("ghp_secret");

      const items = await vault.list();
      expect(items).toHaveLength(1);
      expect(items[0]?.name).toBe("github_token");
      expect(items[0]?.description).toBe("GitHub token");

      expect(await vault.delete("github_token")).toBe(true);
      expect(await vault.has("github_token")).toBe(false);
      expect(await vault.delete("github_token")).toBe(false);
    } finally {
      await vault.close();
    }
  });

  it("returns undefined for missing secrets", async () => {
    const vault = createVault();
    try {
      expect(await vault.get("missing")).toBeUndefined();
    } finally {
      await vault.close();
    }
  });

  it("resolves secret placeholders", async () => {
    const vault = createVault();
    try {
      await vault.set("api_key", "abc123");
      await expect(vault.resolvePlaceholders("Bearer ${vault:api_key}")).resolves.toBe(
        "Bearer abc123",
      );
      await expect(vault.resolvePlaceholders("${vault:unknown}")).rejects.toThrow();
    } finally {
      await vault.close();
    }
  });

  it("audits access without leaking secret values", async () => {
    const events: VaultAuditEvent[] = [];
    const vault = createVault((event) => {
      events.push(event);
    });
    try {
      await vault.set("token", "super-secret-value");
      await vault.get("token");
      expect(events.some((event) => event.action === "set" && event.name === "token")).toBe(true);
      expect(events.some((event) => event.action === "get" && event.name === "token")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("super-secret-value");
    } finally {
      await vault.close();
    }
  });

  it("rejects tampered entries", async () => {
    const path = join(dir, "vault.enc");
    const vault = new Vault({
      path,
      keyProvider: createStaticKeyProvider(masterKey),
      autoLockMinutes: 0,
    });
    await vault.set("token", "value");
    await vault.close();

    const file = JSON.parse(await readFile(path, "utf8")) as {
      entries: Record<string, { data: string }>;
    };
    const entry = file.entries.token;
    if (!entry) {
      throw new Error("Expected entry to exist");
    }
    entry.data = Buffer.from(new Uint8Array(32)).toString("base64");
    await writeFile(path, JSON.stringify(file));

    const reopened = new Vault({
      path,
      keyProvider: createStaticKeyProvider(masterKey),
      autoLockMinutes: 0,
    });
    try {
      await expect(reopened.get("token")).rejects.toThrow();
    } finally {
      await reopened.close();
    }
  });
});
