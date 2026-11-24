import type { AgentTask } from "@myassistant/tasks";
import { isTerminalStatus } from "@myassistant/tasks";

const MAX_NOTIFICATION_CHARS = 3_000;

function truncate(text: string): string {
  if (text.length <= MAX_NOTIFICATION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_NOTIFICATION_CHARS)}\n… (truncated)`;
}

export function formatTaskNotification(task: AgentTask): string | undefined {
  if (!isTerminalStatus(task.status)) {
    return undefined;
  }

  if (task.status === "succeeded") {
    return `任务完成：${task.id}\n\n${truncate(task.output?.trim() || "（没有输出）")}`;
  }
  if (task.status === "failed") {
    return `任务失败：${task.id}\n\n${truncate(task.error ?? "未知错误")}`;
  }
  return `任务已取消：${task.id}`;
}
