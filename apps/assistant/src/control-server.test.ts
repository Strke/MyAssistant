import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlClient } from "./control-client";
import { type ControlServer, createControlServer } from "./control-server";

const tempDirs: string[] = [];
const servers: ControlServer[] = [];

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-socket-"));
  tempDirs.push(dir);
  return join(dir, "assistant.sock");
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createServer(shutdown: () => void): ControlServer {
  const server = createControlServer({
    socketPath: socketPath(),
    handlers: {
      async status() {
        return { pid: 1, ok: true };
      },
      async chat(_requestId, text, _conversationId, emit) {
        emit({ id: "event", type: "event", event: "delta", text: "hel" });
        emit({ id: "event", type: "event", event: "delta", text: "lo" });
        return `reply:${text}`;
      },
      async taskList() {
        return [{ id: "task_1", status: "succeeded" }];
      },
      async taskCheck(taskId) {
        return { taskId, status: "succeeded", output: "done" };
      },
      async taskCancel() {
        return true;
      },
      shutdown,
    },
  });
  servers.push(server);
  return server;
}

describe("control server", () => {
  it("answers ping, status, chat events and task requests", async () => {
    let shutdownCalled = false;
    const server = createServer(() => {
      shutdownCalled = true;
    });
    await server.start();

    const client = new ControlClient({ socketPath: server.path });
    await client.connect();
    try {
      expect(await client.request({ type: "ping" })).toMatchObject({ pong: true });
      expect(await client.request({ type: "status" })).toEqual({ pid: 1, ok: true });

      const deltas: string[] = [];
      const chat = await client.request<{ text: string }>({ type: "chat", text: "hi" }, (event) =>
        deltas.push(event.text),
      );
      expect(chat.text).toBe("reply:hi");
      expect(deltas.join("")).toBe("hello");

      expect(await client.request({ type: "task.list" })).toEqual([
        { id: "task_1", status: "succeeded" },
      ]);
      expect(await client.request({ type: "task.check", taskId: "task_1" })).toMatchObject({
        output: "done",
      });
      expect(await client.request({ type: "task.cancel", taskId: "task_1" })).toEqual({
        cancelled: true,
      });

      await client.request({ type: "shutdown" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(shutdownCalled).toBe(true);
    } finally {
      client.close();
    }
  });

  it("does not start a second server on the same socket", async () => {
    const server = createServer(() => undefined);
    await server.start();
    const second = createControlServer({
      socketPath: server.path,
      handlers: {
        async status() {
          return {};
        },
        async chat() {
          return "";
        },
        async taskList() {
          return [];
        },
        async taskCheck() {
          return {};
        },
        async taskCancel() {
          return false;
        },
        shutdown() {},
      },
    });
    await expect(second.start()).rejects.toThrow("already listening");
  });
});
