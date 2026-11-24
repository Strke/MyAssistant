import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentTask, DispatcherBackend } from "./types";
import { isTerminalStatus } from "./types";

interface TaskFile {
  version: 1;
  tasks: AgentTask[];
}

export interface TaskStore {
  load(): Promise<AgentTask[]>;
  save(task: AgentTask): Promise<void>;
  remove(taskId: string): Promise<void>;
  get(taskId: string): AgentTask | undefined;
  list(): AgentTask[];
  prune(maxRecords: number): Promise<void>;
}

const STATUSES = new Set(["pending", "running", "succeeded", "failed", "cancelled"]);
const BACKENDS = new Set<DispatcherBackend>(["local", "pi-subagent", "pi-rpc", "http-a2a"]);

function cloneTask(task: AgentTask): AgentTask {
  return structuredClone(task);
}

function assertTask(value: unknown): asserts value is AgentTask {
  if (!value || typeof value !== "object") {
    throw new Error("Stored task is not an object.");
  }
  const task = value as Partial<AgentTask>;
  if (
    typeof task.id !== "string" ||
    typeof task.description !== "string" ||
    typeof task.status !== "string" ||
    !STATUSES.has(task.status) ||
    typeof task.backend !== "string" ||
    !BACKENDS.has(task.backend as DispatcherBackend) ||
    typeof task.createdAt !== "number" ||
    typeof task.updatedAt !== "number"
  ) {
    throw new Error(`Stored task is invalid: ${JSON.stringify(value).slice(0, 200)}`);
  }
}

/**
 * JSON-backed task store. The daemon is the single writer; the CLI talks to it
 * over the control socket, so a small atomic JSON file is enough and keeps the
 * data easy to inspect and back up.
 */
export class JsonTaskStore implements TaskStore {
  private readonly path: string;
  private readonly tasks = new Map<string, AgentTask>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<AgentTask[]> {
    if (this.loaded) {
      return this.list();
    }

    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.loaded = true;
      return [];
    }

    if (!raw.trim()) {
      this.loaded = true;
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Task store is not valid JSON (${this.path}): ${message}`);
    }

    const file = parsed as Partial<TaskFile>;
    if (file.version !== 1 || !Array.isArray(file.tasks)) {
      throw new Error(`Unsupported task store format: ${this.path}`);
    }

    for (const task of file.tasks) {
      assertTask(task);
      this.tasks.set(task.id, cloneTask(task));
    }
    this.loaded = true;
    return this.list();
  }

  async save(task: AgentTask): Promise<void> {
    this.tasks.set(task.id, cloneTask(task));
    this.loaded = true;
    await this.enqueueWrite();
  }

  async remove(taskId: string): Promise<void> {
    if (this.tasks.delete(taskId)) {
      await this.enqueueWrite();
    }
  }

  get(taskId: string): AgentTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  list(): AgentTask[] {
    return [...this.tasks.values()]
      .map(cloneTask)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async prune(maxRecords: number): Promise<void> {
    if (maxRecords <= 0 || this.tasks.size <= maxRecords) {
      return;
    }

    const terminal = [...this.tasks.values()]
      .filter((task) => isTerminalStatus(task.status))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const removable = this.tasks.size - maxRecords;
    let removed = 0;
    for (const task of terminal) {
      if (removed >= removable) {
        break;
      }
      this.tasks.delete(task.id);
      removed += 1;
    }
    if (removed > 0) {
      await this.enqueueWrite();
    }
  }

  private enqueueWrite(): Promise<void> {
    const run = this.writeQueue.then(
      () => this.write(),
      () => this.write(),
    );
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async write(): Promise<void> {
    const file: TaskFile = { version: 1, tasks: this.list() };
    await mkdir(dirname(resolve(this.path)), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.path);
    await chmod(this.path, 0o600);
  }
}

export function openTaskStore(path: string): JsonTaskStore {
  return new JsonTaskStore(path);
}
