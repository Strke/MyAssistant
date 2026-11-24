import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlackboardStore } from "./blackboard";

const dirs: string[] = [];

function store(maxCompleted = 5, clock = { now: 1_000 }): BlackboardStore {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-blackboard-"));
  dirs.push(dir);
  return new BlackboardStore(join(dir, "blackboard.json"), maxCompleted, () => clock.now);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("BlackboardStore", () => {
  it("adds open items and deduplicates by title", async () => {
    const clock = { now: 1_000 };
    const board = store(5, clock);
    await board.init();

    const first = await board.add({ title: "确认漏洞修复", details: "old" });
    clock.now = 2_000;
    const second = await board.add({ title: "确认  漏洞修复", details: "new" });

    expect(second.item.id).toBe(first.item.id);
    expect(board.openItems()).toHaveLength(1);
    expect(board.openItems()[0]?.details).toBe("new");
  });

  it("completes items and keeps only the latest completed items", async () => {
    const clock = { now: 1_000 };
    const board = store(2, clock);
    await board.init();
    const ids: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      clock.now += 1_000;
      const added = await board.add({ title: `任务 ${index}` });
      ids.push(added.item.id);
      clock.now += 1_000;
      await board.complete(added.item.id);
    }

    expect(board.openItems()).toHaveLength(0);
    expect(board.completedItems()).toHaveLength(2);
    expect(board.completedItems().map((item) => item.title)).toEqual(["任务 3", "任务 2"]);
    expect(board.render()).toContain("最近完成（最多 2 项）");
  });

  it("persists and reloads items", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myassistant-blackboard-"));
    dirs.push(dir);
    const path = join(dir, "blackboard.json");
    const first = new BlackboardStore(path);
    await first.init();
    await first.add({ title: "持久化任务" });

    const second = new BlackboardStore(path);
    await second.init();
    expect(second.openItems()[0]?.title).toBe("持久化任务");
  });
});
