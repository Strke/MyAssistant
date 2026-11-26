import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonAssetStore } from "./store";

const dirs: string[] = [];

function store(): { store: JsonAssetStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-assets-"));
  dirs.push(dir);
  const path = join(dir, "assets.json");
  return { store: new JsonAssetStore(path), path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("JsonAssetStore", () => {
  it("saves, lists, reloads and deletes assets", async () => {
    const { store: first, path } = store();
    await first.init();
    await first.save({
      id: "mac-mini",
      name: "Mac mini",
      kind: "server",
      addresses: ["100.88.41.16"],
      tags: ["mac", "tailscale"],
      access: [
        {
          method: "ssh",
          username: "renzelin",
          secretName: "macmini_ssh",
          secretKind: "ssh_key",
        },
      ],
    });

    const second = new JsonAssetStore(path);
    await second.init();
    const asset = await second.get("mac-mini");
    expect(asset).toMatchObject({
      id: "mac-mini",
      name: "Mac mini",
      kind: "server",
      status: "active",
      addresses: ["100.88.41.16"],
      tags: ["mac", "tailscale"],
      access: [
        {
          id: "ssh",
          method: "ssh",
          host: "100.88.41.16",
          username: "renzelin",
          secretName: "macmini_ssh",
          secretKind: "ssh_key",
        },
      ],
    });
    expect(asset?.createdAt).toBeTypeOf("number");

    expect((await second.list()).map((item) => item.id)).toEqual(["mac-mini"]);
    expect(await second.delete("mac-mini")).toBe(true);
    expect(await second.delete("mac-mini")).toBe(false);
    expect(await second.get("mac-mini")).toBeUndefined();
  });

  it("preserves createdAt and replaces updatedAt on update", async () => {
    let now = 1_000;
    const dir = mkdtempSync(join(tmpdir(), "myassistant-assets-"));
    dirs.push(dir);
    const assets = new JsonAssetStore(join(dir, "assets.json"), () => now);
    await assets.init();
    const created = await assets.save({ id: "nas", name: "NAS" });

    now = 5_000;
    const updated = await assets.save({ id: "nas", name: "NAS 2", status: "retired" });
    expect(created.createdAt).toBe(1_000);
    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(5_000);
    expect(updated.name).toBe("NAS 2");
    expect(updated.status).toBe("retired");
  });

  it("makes duplicate access ids unique", async () => {
    const { store: assets } = store();
    await assets.init();
    const asset = await assets.save({
      id: "server",
      name: "Server",
      access: [
        { method: "ssh", host: "10.0.0.1" },
        { method: "ssh", host: "10.0.0.2" },
      ],
    });
    expect(asset.access.map((entry) => entry.id)).toEqual(["ssh", "ssh-2"]);
  });

  it("reloads external file changes without reinitializing", async () => {
    const { store: first, path } = store();
    await first.init();
    await first.save({ id: "first", name: "First" });

    const second = new JsonAssetStore(path);
    await second.init();
    await first.save({ id: "second", name: "Second" });

    expect((await second.list()).map((asset) => asset.id)).toEqual(["first", "second"]);
    expect(await second.get("second")).toMatchObject({ name: "Second" });
  });

  it("rejects invalid ids, kinds and secret names", async () => {
    const { store: assets } = store();
    await assets.init();
    await expect(assets.save({ id: "bad id", name: "Bad" })).rejects.toThrow("Asset id");
    await expect(
      assets.save({ id: "bad-kind", name: "Bad", kind: "toaster" as never }),
    ).rejects.toThrow("Invalid asset kind");
    await expect(
      assets.save({
        id: "bad-secret",
        name: "Bad",
        access: [{ method: "ssh", secretName: "bad secret" }],
      }),
    ).rejects.toThrow("Invalid secret name");
  });
});
