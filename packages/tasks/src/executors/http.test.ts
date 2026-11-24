import { describe, expect, it } from "vitest";
import type { AgentTask } from "../types";
import { HttpTaskExecutor } from "./http";

const task: AgentTask = {
  id: "task_1",
  description: "do the thing",
  status: "running",
  backend: "http-a2a",
  createdAt: 1,
  updatedAt: 1,
};

function fetchSequence(responses: Array<() => Response>): typeof fetch {
  let index = 0;
  return (async () => {
    const factory = responses[index];
    index += 1;
    if (!factory) {
      throw new Error("Unexpected fetch call.");
    }
    return factory();
  }) as typeof fetch;
}

describe("HttpTaskExecutor", () => {
  it("posts a task and polls until it succeeds", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "remote-1", status: "pending" }), {
          status: 202,
        });
      }
      return new Response(JSON.stringify({ status: "succeeded", output: "all done" }), {
        status: 200,
      });
    }) as typeof fetch;

    const executor = new HttpTaskExecutor({
      baseUrl: "http://example.test/tasks",
      pollIntervalMs: 100,
      fetchImpl,
    });
    const output = await executor.run(task, new AbortController().signal);

    expect(output).toBe("all done");
    expect(calls).toEqual([
      "POST http://example.test/tasks",
      "GET http://example.test/tasks/remote-1",
    ]);
  });

  it("returns an immediate terminal result without polling", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: "succeeded", output: "instant" }), {
        status: 200,
      })) as typeof fetch;

    const executor = new HttpTaskExecutor({
      baseUrl: "http://example.test/tasks",
      fetchImpl,
    });
    expect(await executor.run(task, new AbortController().signal)).toBe("instant");
  });

  it("throws when the remote task fails", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: "failed", error: "boom" }), {
        status: 200,
      })) as typeof fetch;

    const executor = new HttpTaskExecutor({
      baseUrl: "http://example.test/tasks",
      fetchImpl,
    });
    await expect(executor.run(task, new AbortController().signal)).rejects.toThrow("boom");
  });

  it("rejects non-http base urls", () => {
    expect(
      () => new HttpTaskExecutor({ baseUrl: "file:///tmp/tasks", fetchImpl: fetchSequence([]) }),
    ).toThrow("http(s)");
  });
});
