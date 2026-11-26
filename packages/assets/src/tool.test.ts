import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonAssetStore } from "./store";
import { createAssetTools } from "./tool";

const dirs: string[] = [];

type ExecutableTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
};

async function setup(): Promise<ExecutableTool[]> {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-asset-tools-"));
  dirs.push(dir);
  const store = new JsonAssetStore(join(dir, "assets.json"));
  await store.init();
  await store.save({
    id: "mac-mini",
    name: "Mac mini",
    kind: "server",
    addresses: ["100.88.41.16"],
    tags: ["mac", "tailscale"],
    access: [
      {
        id: "tailscale-ssh",
        method: "ssh",
        username: "renzelin",
        secretName: "macmini_ssh",
        secretKind: "ssh_key",
      },
    ],
  });
  return createAssetTools(store) as unknown as ExecutableTool[];
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("asset tools", () => {
  it("lists assets without secret values", async () => {
    const tools = await setup();
    const list = tools.find((tool) => tool.name === "asset_list");
    const result = await list?.execute("call", {});
    const text = result?.content[0]?.text ?? "";
    expect(text).toContain("mac-mini");
    expect(text).toContain("secret=macmini_ssh");
    expect(text).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("returns full asset metadata and connection details", async () => {
    const tools = await setup();
    const get = tools.find((tool) => tool.name === "asset_get");
    const connection = tools.find((tool) => tool.name === "asset_connection");

    const getResult = await get?.execute("call", { id: "mac-mini" });
    const getText = getResult?.content[0]?.text ?? "";
    expect(getText).toContain('"secretName": "macmini_ssh"');
    expect(getText).not.toContain("PRIVATE KEY");

    const connectionResult = await connection?.execute("call", { id: "mac-mini" });
    const connectionText = connectionResult?.content[0]?.text ?? "";
    expect(connectionText).toContain('"command": "ssh -p 22 renzelin@100.88.41.16"');
    expect(connectionText).toContain('"secretName": "macmini_ssh"');
    expect(connectionText).not.toContain("PRIVATE KEY");
  });
});
