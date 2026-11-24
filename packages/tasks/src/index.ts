export interface AgentTask {
  id: string;
  description: string;
  target?: string;
  createdAt: number;
}

export type AgentTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentTaskResult {
  taskId: string;
  status: AgentTaskStatus;
  output?: string;
  error?: string;
  updatedAt: number;
}

export interface AgentDispatcher {
  delegate(task: AgentTask): Promise<string>;
  poll(taskId: string): Promise<AgentTaskResult>;
  cancel(taskId: string): Promise<boolean>;
}

export type DispatcherBackend = "local" | "pi-subagent" | "pi-rpc" | "http-a2a";
