import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskManager } from "./manager";
import { JsonTaskStore } from "./store";
import type { AgentTask, TaskExecutor } from "./types";

class TestExecutor implements TaskExecutor {
  active = 0;
  maxActive = 0;
  readonly runs: string[] = [];
  delayMs = 10;
  blockAll = false;
  private readonly blockers = new Map<string, Promise<string>>();
  private readonly blocked = new Set<string>();
  private readonly resolvers = new Map<string, (value: string) => void>();

  block(taskId: string): void {
    this.blocked.add(taskId);
    this.ensureBlocker(taskId);
  }

  release(taskId: string, value = "released"): void {
    this.resolvers.get(taskId)?.(value);
  }

  private ensureBlocker(taskId: string): Promise<string> {
    const existing = this.blockers.get(taskId);
    if (existing) {
      return existing;
    }
    const promise = new Promise<string>((resolve) => {
      this.resolvers.set(taskId, resolve);
    });
    this.blockers.set(taskId, promise);
    return promise;
  }

  async run(task: AgentTask, signal: AbortSignal): Promise<string> {
    this.runs.push(task.id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.blockAll || this.blocked.has(task.id)) {
        return await Promise.race([
          this.ensureBlocker(task.id),
          new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ]);
      }
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (signal.aborted) {
        throw new Error("aborted");
      }
      return `done:${task.description}`;
    } finally {
      this.active -= 1;
    }
  }
}

const tempDirs: string[] = [];

function tempTaskPath(name = "tasks.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-tasks-"));
  tempDirs.push(dir);
  return join(dir, name);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TaskManager", () => {
  it("runs a task to completion and persists the result", async () => {
    const path = tempTaskPath();
    const manager = new TaskManager({
      store: new JsonTaskStore(path),
      executor: new TestExecutor(),
      backend: "local",
    });
    await manager.init();

    const id = await manager.delegate({ description: "say hello" });
    const result = await waitFor(async () => {
      const current = await manager.poll(id);
      return current.status === "succeeded" ? current : undefined;
    });

    expect(result.output).toBe("done:say hello");
    await manager.close();

    const reopened = new JsonTaskStore(path);
    await reopened.load();
    expect(reopened.get(id)?.output).toBe("done:say hello");
  });

  it("respects the concurrency limit", async () => {
    const executor = new TestExecutor();
    const manager = new TaskManager({
      store: new JsonTaskStore(tempTaskPath()),
      executor,
      backend: "local",
      concurrency: 2,
    });
    await manager.init();

    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, index) => manager.delegate({ description: `task ${index}` })),
    );
    await waitFor(async () => {
      const tasks = await manager.list("succeeded");
      return tasks.length === ids.length ? tasks : undefined;
    });

    expect(executor.maxActive).toBeLessThanOrEqual(2);
    await manager.close();
  });

  it("cancels a pending task without running it", async () => {
    const executor = new TestExecutor();
    const manager = new TaskManager({
      store: new JsonTaskStore(tempTaskPath()),
      executor,
      backend: "local",
      concurrency: 1,
    });
    await manager.init();

    executor.blockAll = true;
    const runningId = await manager.delegate({ description: "slow" });
    const queuedId = await manager.delegate({ description: "queued" });

    await waitFor(async () => {
      const task = await manager.get(queuedId);
      return task?.status === "pending" ? task : undefined;
    });
    expect(await manager.cancel(queuedId)).toBe(true);

    const cancelled = await manager.poll(queuedId);
    expect(cancelled.status).toBe("cancelled");
    expect(executor.runs).not.toContain(queuedId);

    executor.release(runningId);
    await waitFor(async () => {
      const task = await manager.get(runningId);
      return task?.status === "succeeded" ? task : undefined;
    });
    await manager.close();
  });

  it("aborts a running task on cancel", async () => {
    const executor = new TestExecutor();
    const manager = new TaskManager({
      store: new JsonTaskStore(tempTaskPath()),
      executor,
      backend: "local",
    });
    await manager.init();

    executor.blockAll = true;
    const id = await manager.delegate({ description: "run forever" });
    await waitFor(async () => {
      const task = await manager.get(id);
      return task?.status === "running" ? task : undefined;
    });

    expect(await manager.cancel(id)).toBe(true);
    const result = await manager.poll(id);
    expect(result.status).toBe("cancelled");
    await manager.close();
  });

  it("marks timed out tasks as failed", async () => {
    const executor = new TestExecutor();
    const manager = new TaskManager({
      store: new JsonTaskStore(tempTaskPath()),
      executor,
      backend: "local",
      timeoutMs: 30,
    });
    await manager.init();

    executor.blockAll = true;
    const id = await manager.delegate({ description: "timeout" });
    const result = await waitFor(async () => {
      const current = await manager.poll(id);
      return current.status === "failed" ? current : undefined;
    });

    expect(result.error).toContain("timed out");
    await manager.close();
  });

  it("marks tasks interrupted by a restart as failed", async () => {
    const path = tempTaskPath();
    const store = new JsonTaskStore(path);
    await store.save({
      id: "task_interrupted",
      description: "was running",
      status: "running",
      backend: "local",
      createdAt: 1,
      updatedAt: 2,
      startedAt: 2,
    });

    const manager = new TaskManager({
      store: new JsonTaskStore(path),
      executor: new TestExecutor(),
      backend: "local",
    });
    await manager.init();

    const task = await manager.get("task_interrupted");
    expect(task?.status).toBe("failed");
    expect(task?.error).toContain("interrupted");
    await manager.close();
  });

  it("prunes old terminal records", async () => {
    const store = new JsonTaskStore(tempTaskPath());
    const manager = new TaskManager({
      store,
      executor: new TestExecutor(),
      backend: "local",
      maxRecords: 2,
    });
    await manager.init();

    for (let index = 0; index < 4; index += 1) {
      const id = await manager.delegate({ description: `task ${index}` });
      await waitFor(async () => {
        const task = await manager.get(id);
        return task?.status === "succeeded" ? task : undefined;
      });
    }

    expect(store.list().length).toBeLessThanOrEqual(2);
    await manager.close();
  });

  it("forwards completion notifications through task metadata", async () => {
    const manager = new TaskManager({
      store: new JsonTaskStore(tempTaskPath()),
      executor: new TestExecutor(),
      backend: "local",
    });
    await manager.init();

    const id = await manager.delegate({
      description: "notify",
      notify: { channel: "dingtalk", conversationId: "cid" },
    });
    const task = await waitFor(async () => {
      const current = await manager.get(id);
      return current?.status === "succeeded" ? current : undefined;
    });
    expect(task.notify).toEqual({ channel: "dingtalk", conversationId: "cid" });
    await manager.close();
  });
});
