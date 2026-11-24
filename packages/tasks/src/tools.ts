import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { AgentTaskStatus, TaskService } from "./types";

export interface TaskToolContext {
  channel?: string;
  conversationId?: string;
}

interface DelegateTaskParams {
  description: string;
  target?: string;
}

interface CheckTaskParams {
  taskId: string;
}

interface ListTasksParams {
  status?: string;
}

const MAX_TOOL_OUTPUT_CHARS = 8_000;
const STATUSES: AgentTaskStatus[] = ["pending", "running", "succeeded", "failed", "cancelled"];

function truncate(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n… (truncated ${text.length - max} characters)`;
}

export function createTaskTools(taskService: TaskService, context: TaskToolContext = {}) {
  const notify =
    context.channel && context.conversationId
      ? { channel: context.channel, conversationId: context.conversationId }
      : undefined;

  const delegateTask = defineTool({
    name: "delegate_task",
    label: "Delegate Task",
    description:
      "Delegate a long-running or independent task to a background agent. Returns immediately with a task id. " +
      "After delegating, tell the user the task id; do not wait or claim it is finished. Use check_task to fetch the result later.",
    parameters: obj({
      description: str({
        description:
          "A complete, self-contained task brief. Include all context the sub-agent needs, expected output, and constraints.",
      }),
      target: opt(
        str({
          description:
            "Optional hint about where to run the task, such as a repository path, service name, or agent target.",
        }),
      ),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as DelegateTaskParams;
      const taskId = await taskService.delegate({
        description: params.description,
        target: params.target,
        notify,
      });
      return {
        content: [
          {
            type: "text",
            text: `Task queued: ${taskId}\nIt is running in the background. Use check_task with this id to see progress or results.`,
          },
        ],
        details: { taskId, status: "pending" },
      };
    },
  });

  const checkTask = defineTool({
    name: "check_task",
    label: "Check Task",
    description:
      "Check a delegated task by id. Returns its status, and the output or error once it has finished.",
    parameters: obj({
      taskId: str({ description: "Task id returned by delegate_task." }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as CheckTaskParams;
      const result = await taskService.poll(params.taskId);
      const text = [
        `task: ${result.taskId}`,
        `status: ${result.status}`,
        result.error ? `error: ${result.error}` : undefined,
        result.output ? `output:\n${truncate(result.output)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }], details: result };
    },
  });

  const cancelTask = defineTool({
    name: "cancel_task",
    label: "Cancel Task",
    description: "Cancel a pending or running delegated task by id.",
    parameters: obj({
      taskId: str({ description: "Task id to cancel." }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as CheckTaskParams;
      const cancelled = await taskService.cancel(params.taskId);
      return {
        content: [
          {
            type: "text",
            text: cancelled
              ? `Task ${params.taskId} was cancelled.`
              : `Task ${params.taskId} is not running or does not exist.`,
          },
        ],
        details: { taskId: params.taskId, cancelled },
      };
    },
  });

  const listTasks = defineTool({
    name: "list_tasks",
    label: "List Tasks",
    description:
      "List recent delegated tasks, optionally filtered by status (pending, running, succeeded, failed, cancelled).",
    parameters: obj({
      status: opt(str({ description: "Optional status filter." })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as ListTasksParams;
      const status = params.status?.trim() as AgentTaskStatus | undefined;
      if (status && !STATUSES.includes(status)) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown status "${status}". Use one of: ${STATUSES.join(", ")}.`,
            },
          ],
          details: { tasks: 0 },
        };
      }
      const tasks = (await taskService.list(status)).slice(0, 20);
      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No delegated tasks found." }],
          details: { tasks: 0 },
        };
      }
      const text = tasks
        .map(
          (task) =>
            `- ${task.id} [${task.status}] ${new Date(task.createdAt).toISOString()} ${task.description.slice(0, 120)}`,
        )
        .join("\n");
      return { content: [{ type: "text", text }], details: { tasks: tasks.length } };
    },
  });

  return [delegateTask, checkTask, cancelTask, listTasks] as unknown as ToolDefinition[];
}
