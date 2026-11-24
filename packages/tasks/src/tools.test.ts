import { describe, expect, it } from "vitest";
import { createTaskTools } from "./tools";
import type { AgentTask, AgentTaskStatus, TaskService } from "./types";

class FakeTaskService implements TaskService {
  delegated: unknown;
  readonly tasks: AgentTask[] = [];

  async delegate(task: unknown): Promise<string> {
    this.delegated = task;
    return "task_123";
  }

  async poll(taskId: string) {
    return {
      taskId,
      status: "succeeded" as const,
      output: "result text",
      updatedAt: Date.now(),
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  async get(taskId: string): Promise<AgentTask | undefined> {
    return this.tasks.find((task) => task.id === taskId);
  }

  async list(status?: AgentTaskStatus): Promise<AgentTask[]> {
    return this.tasks.filter((task) => !status || task.status === status);
  }
}

async function runTool(
  tool: unknown,
  params: unknown,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> {
  const definition = tool as {
    execute: (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
  };
  return definition.execute("call-1", params, undefined, undefined, {});
}

describe("createTaskTools", () => {
  it("binds the conversation as the notification target", async () => {
    const service = new FakeTaskService();
    const tools = createTaskTools(service, {
      channel: "dingtalk",
      conversationId: "cid-1",
    });
    const delegate = tools.find((tool) => tool.name === "delegate_task");
    expect(delegate).toBeDefined();

    const result = await runTool(delegate, { description: "do it" });
    expect(result.content[0]?.text).toContain("task_123");
    expect(service.delegated).toMatchObject({
      description: "do it",
      notify: { channel: "dingtalk", conversationId: "cid-1" },
    });
  });

  it("formats task results and rejects unknown status filters", async () => {
    const service = new FakeTaskService();
    const tools = createTaskTools(service);
    const check = tools.find((tool) => tool.name === "check_task");
    const list = tools.find((tool) => tool.name === "list_tasks");

    const checked = await runTool(check, { taskId: "task_123" });
    expect(checked.content[0]?.text).toContain("result text");

    const invalid = await runTool(list, { status: "bogus" });
    expect(invalid.content[0]?.text).toContain("Unknown status");
  });
});
