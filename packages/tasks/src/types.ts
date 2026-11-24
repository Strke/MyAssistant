export type AgentTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type DispatcherBackend = "local" | "pi-subagent" | "pi-rpc" | "http-a2a";

export interface TaskNotificationTarget {
  /** Channel that should receive completion updates, for example "dingtalk" or "local". */
  channel: string;
  /** Channel-specific conversation id. */
  conversationId: string;
}

export interface AgentTask {
  id: string;
  description: string;
  target?: string;
  status: AgentTaskStatus;
  backend: DispatcherBackend;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  notify?: TaskNotificationTarget;
  metadata?: Record<string, unknown>;
}

export interface NewAgentTask {
  description: string;
  target?: string;
  notify?: TaskNotificationTarget;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskResult {
  taskId: string;
  status: AgentTaskStatus;
  output?: string;
  error?: string;
  updatedAt: number;
}

export interface AgentDispatcher {
  delegate(task: NewAgentTask): Promise<string>;
  poll(taskId: string): Promise<AgentTaskResult>;
  cancel(taskId: string): Promise<boolean>;
}

export interface TaskService extends AgentDispatcher {
  list(status?: AgentTaskStatus): Promise<AgentTask[]>;
  get(taskId: string): Promise<AgentTask | undefined>;
}

/**
 * Runs one task to completion. Implementations must stop promptly when the
 * signal aborts and reject with an AbortError-compatible error.
 */
export interface TaskExecutor {
  run(task: AgentTask, signal: AbortSignal): Promise<string>;
}

export interface TaskUpdateEvent {
  task: AgentTask;
  previousStatus: AgentTaskStatus;
}

export type TaskUpdateListener = (event: TaskUpdateEvent) => void;

export function isTerminalStatus(status: AgentTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function toTaskResult(task: AgentTask): AgentTaskResult {
  return {
    taskId: task.id,
    status: task.status,
    output: task.output,
    error: task.error,
    updatedAt: task.updatedAt,
  };
}
