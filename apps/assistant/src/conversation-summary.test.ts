import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationSummaryStore } from "./conversation-summary";

const dirs: string[] = [];

function store(): { store: ConversationSummaryStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-summary-"));
  dirs.push(dir);
  const path = join(dir, "summaries.json");
  return { store: new ConversationSummaryStore(path), path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ConversationSummaryStore", () => {
  it("stores and reloads per-conversation summaries", async () => {
    const { store: first, path } = store();
    await first.init();
    await first.set("dingtalk:c1", "summary one");

    const second = new ConversationSummaryStore(path);
    await second.init();
    expect(await second.get("dingtalk:c1")).toBe("summary one");
    expect(await second.get("dingtalk:c2")).toBeUndefined();
  });

  it("ignores empty summaries", async () => {
    const { store: summaries } = store();
    await summaries.init();
    await summaries.set("dingtalk:c1", "   ");
    expect(await summaries.get("dingtalk:c1")).toBeUndefined();
  });

  it("serializes updates per conversation", async () => {
    const { store: summaries } = store();
    await summaries.init();
    await summaries.set("dingtalk:c1", "base");

    const first = summaries.update("dingtalk:c1", async (current) => `${current ?? ""}+a`);
    const second = summaries.update("dingtalk:c1", async (current) => `${current ?? ""}+b`);
    await Promise.all([first, second]);

    expect(await summaries.get("dingtalk:c1")).toBe("base+a+b");
  });
});
