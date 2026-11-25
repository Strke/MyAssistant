import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplyBlockStore } from "./reply-block";

const dirs: string[] = [];

function store(): { store: ReplyBlockStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-block-"));
  dirs.push(dir);
  const path = join(dir, "blocks.json");
  return { store: new ReplyBlockStore(path), path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ReplyBlockStore", () => {
  it("stores and reloads the last reply per conversation", async () => {
    const { store: first, path } = store();
    await first.init();
    await first.set("dingtalk:c1", "收到，我看一下。", ["m1", "m2"]);

    const second = new ReplyBlockStore(path);
    await second.init();
    expect(second.get("dingtalk:c1")).toMatchObject({
      text: "收到，我看一下。",
      messageIds: ["m1", "m2"],
    });
    expect(second.get("dingtalk:c2")).toBeUndefined();
  });

  it("extends a block without changing the reply time", async () => {
    let now = 1_000;
    const dir = mkdtempSync(join(tmpdir(), "myassistant-block-"));
    dirs.push(dir);
    const blocks = new ReplyBlockStore(join(dir, "blocks.json"), () => now);
    await blocks.init();
    await blocks.set("dingtalk:c1", "收到。", ["m1"]);

    now = 5_000;
    await blocks.extend("dingtalk:c1", ["m2", "m2", "m3"]);

    expect(blocks.get("dingtalk:c1")).toEqual({
      text: "收到。",
      repliedAt: 1_000,
      messageIds: ["m1", "m2", "m3"],
    });
  });

  it("ignores empty replies", async () => {
    const { store: blocks } = store();
    await blocks.init();
    await blocks.set("dingtalk:c1", "   ", ["m1"]);
    expect(blocks.get("dingtalk:c1")).toBeUndefined();
  });
});
