import { randomBytes } from "node:crypto";
import type { TaskStore } from "./store";
import type {
  AgentTask,
  AgentTaskResult,
  AgentTaskStatus,
  DispatcherBackend,
  NewAgentTask,
  TaskExecutor,
  TaskService,
  TaskUpdateEvent,
  TaskUpdateListener,
} from "./types";
import { isTerminalStatus, toTaskResult } from "./types";

export interface TaskManagerOptions {
  store: TaskStore;
  executor: TaskExecutor;
  backend: DispatcherBackend;
  concurrency?: number;
  timeoutMs?: number;
  maxRecords?: number;
  now?: () => number;
  idFactory?: (now: number) => string;
  onError?: (error: unknown) => void;
}

interface RunningTask {
  controller: AbortController;
  promise: Promise<void>;
  timedOut: boolean;
}

const MAX_DESCRIPTION_CHARS = 20_000;
const CLOSE_GRACE_MS = 5_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function defaultIdFactory(now: number): string {
  return `task_${now.toString(36)}_${randomBytes(5).toString("hex")}`;
}

export class TaskManager implements TaskService {
  private readonly store: TaskStore;
  private readonly executor: TaskExecutor;
  private readonly backend: DispatcherBackend;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private readonly idFactory: (now: number) => string;
  private readonly onError?: (error: unknown) => void;
  private readonly listeners = new Set<TaskUpdateListener>();
  private readonly queue: string[] = [];
  private readonly running = new Map<string, RunningTask>();
  private readonly cancelled = new Set<string>();
  private initialization: Promise<void> | undefined;
  private pumping = false;
  private pumpRequested = false;
  private closed = false;

  constructor(options: TaskManagerOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.backend = options.backend;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.timeoutMs = Math.max(0, options.timeoutMs ?? 30 * 60_000);
    this.maxRecords = Math.max(0, options.maxRecords ?? 500);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.onError = options.onError;
  }

  async init(): Promise<void> {
    this.initialization ??= this.recover();
    await this.initialization;
  }

  onUpdate(listener: TaskUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async delegate(input: NewAgentTask): Promise<string> {
    await this.ensureReady();
    if (this.closed) {
      throw new Error("Task manager is shutting down.");
    }

    const description = input.description.trim();
    if (!description) {
      throw new Error("Task description must not be empty.");
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(`Task description is too long (max ${MAX_DESCRIPTION_CHARS} characters).`);
    }
    if (input.target && input.target.length > 200) {
      throw new Error("Task target is too long (max 200 characters).");
    }

    const timestamp = this.now();
    const task: AgentTask = {
      id: this.idFactory(timestamp),
      description,
      target: input.target,
      status: "pending",
      backend: this.backend,
      createdAt: timestamp,
      updatedAt: timestamp,
      notify: input.notify,
      metadata: input.metadata,
    };

    await this.store.save(task);
    if (this.closed) {
      task.status = "cancelled";
      task.error = "Cancelled because the assistant is shutting down.";
      task.finishedAt = this.now();
      task.updatedAt = task.finishedAt;
      this.cancelled.add(task.id);
      await this.saveQuietly(task);
      throw new Error("Task manager is shutting down.");
    }
    this.emit(task, "pending");
    this.queue.push(task.id);
    this.pump();
    return task.id;
  }

  async poll(taskId: string): Promise<AgentTaskResult> {
    await this.ensureReady();
    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return toTaskResult(task);
  }

  async cancel(taskId: string): Promise<boolean> {
    await this.ensureReady();
    const task = this.store.get(taskId);
    if (!task || isTerminalStatus(task.status)) {
      return false;
    }

    this.cancelled.add(taskId);
    if (task.status === "pending") {
      const index = this.queue.indexOf(taskId);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
      const previous = task.status;
      task.status = "cancelled";
      task.error = "Cancelled before the task started.";
      task.finishedAt = this.now();
      task.updatedAt = task.finishedAt;
      await this.save(task);
      this.emit(task, previous);
      await this.prune();
      return true;
    }

    const running = this.running.get(taskId);
    const previous = task.status;
    task.status = "cancelled";
    task.error = "Cancelled by user.";
    task.finishedAt = this.now();
    task.updatedAt = task.finishedAt;
    await this.save(task);
    this.emit(task, previous);
    running?.controller.abort(new Error("Task cancelled."));
    return true;
  }

  async get(taskId: string): Promise<AgentTask | undefined> {
    await this.ensureReady();
    return this.store.get(taskId);
  }

  async list(status?: AgentTaskStatus): Promise<AgentTask[]> {
    await this.ensureReady();
    return this.store
      .list()
      .filter((task) => !status || task.status === status)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async counts(): Promise<Record<AgentTaskStatus, number>> {
    await this.ensureReady();
    const counts: Record<AgentTaskStatus, number> = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of this.store.list()) {
      counts[task.status] += 1;
    }
    return counts;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const taskId of [...this.queue]) {
      const task = this.store.get(taskId);
      if (!task) {
        continue;
      }
      if (task.status !== "pending") {
        continue;
      }
      const previous = task.status;
      task.status = "cancelled";
      task.error = "Cancelled because the assistant is shutting down.";
      task.finishedAt = this.now();
      task.updatedAt = task.finishedAt;
      this.cancelled.add(taskId);
      await this.save(task);
      this.emit(task, previous);
    }
    this.queue.length = 0;

    for (const [taskId, running] of this.running) {
      const task = this.store.get(taskId);
      if (task?.status !== "running") {
        running.controller.abort(new Error("Task manager shutting down."));
        continue;
      }
      this.cancelled.add(taskId);
      const previous = task.status;
      task.status = "cancelled";
      task.error = "Cancelled because the assistant is shutting down.";
      task.finishedAt = this.now();
      task.updatedAt = task.finishedAt;
      await this.save(task);
      this.emit(task, previous);
      running.controller.abort(new Error("Task manager shutting down."));
    }

    const waits = [...this.running.values()].map((running) => running.promise);
    if (waits.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(waits),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async ensureReady(): Promise<void> {
    this.initialization ??= this.recover();
    await this.initialization;
  }

  private async recover(): Promise<void> {
    const tasks = await this.store.load();
    for (const task of tasks) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }
      const previous = task.status;
      task.status = "failed";
      task.error = "Task was interrupted by an assistant restart. Delegate it again if needed.";
      task.finishedAt = this.now();
      task.updatedAt = task.finishedAt;
      await this.save(task);
      this.emit(task, previous);
    }
    await this.prune();
  }

  private pump(): void {
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    if (this.pumping || this.closed) {
      return;
    }
    this.pumping = true;
    try {
      while (!this.closed && this.running.size < this.concurrency) {
        const taskId = this.queue.shift();
        if (!taskId) {
          break;
        }
        const task = this.store.get(taskId);
        if (!task) {
          continue;
        }
        if (task.status !== "pending") {
          continue;
        }

        const previous = task.status;
        task.status = "running";
        task.startedAt = this.now();
        task.updatedAt = task.startedAt;
        try {
          await this.save(task);
        } catch (error) {
          this.reportError(error);
          task.status = "failed";
          task.error = "Failed to persist task state before starting.";
          task.finishedAt = this.now();
          task.updatedAt = task.finishedAt;
          await this.saveQuietly(task);
          this.emit(task, previous);
          continue;
        }
        if (this.closed) {
          task.status = "cancelled";
          task.error = "Cancelled because the assistant is shutting down.";
          task.finishedAt = this.now();
          task.updatedAt = task.finishedAt;
          this.cancelled.add(task.id);
          await this.saveQuietly(task);
          break;
        }

        if (this.cancelled.has(task.id) || this.store.get(task.id)?.status === "cancelled") {
          continue;
        }

        this.emit(task, previous);

        const running: RunningTask = {
          controller: new AbortController(),
          promise: Promise.resolve(),
          timedOut: false,
        };
        this.running.set(taskId, running);
        running.promise = this.execute(task, running).finally(() => {
          this.running.delete(taskId);
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
      if (this.pumpRequested) {
        this.pumpRequested = false;
        this.pump();
      }
    }
  }

  private async execute(task: AgentTask, running: RunningTask): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    if (this.timeoutMs > 0) {
      timer = setTimeout(() => {
        running.timedOut = true;
        running.controller.abort(new Error("Task timed out."));
      }, this.timeoutMs);
      timer.unref?.();
    }

    try {
      const output = await this.executor.run(task, running.controller.signal);
      if (this.cancelled.has(task.id) || task.status === "cancelled") {
        return;
      }
      if (running.timedOut) {
        throw new Error(`Task timed out after ${Math.round(this.timeoutMs / 1000)} seconds.`);
      }
      task.status = "succeeded";
      task.output = output;
      task.error = undefined;
      task.finishedAt = this.now();
      task.updatedAt = task.finishedAt;
    } catch (error) {
      if (this.cancelled.has(task.id) || task.status === "cancelled") {
        return;
      }
      task.status = "failed";
      task.error = running.timedOut
        ? `Task timed out after ${Math.round(this.timeoutMs / 1000)} seconds.`
        : errorMessage(error);
      task.finishedAt = this.now();
      task.updatedAt = task.finishedAt;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    await this.saveQuietly(task);
    this.emit(task, "running");
    await this.prune();
  }

  private async save(task: AgentTask): Promise<void> {
    await this.store.save(task);
  }

  private async saveQuietly(task: AgentTask): Promise<void> {
    try {
      await this.store.save(task);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async prune(): Promise<void> {
    try {
      await this.store.prune(this.maxRecords);
    } catch (error) {
      this.reportError(error);
    }
  }

  private emit(task: AgentTask, previousStatus: AgentTaskStatus): void {
    const event: TaskUpdateEvent = {
      task: structuredClone(task),
      previousStatus,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    if (this.onError) {
      this.onError(error);
      return;
    }
    process.stderr.write(`[tasks] ${errorMessage(error)}\n`);
  }
}
