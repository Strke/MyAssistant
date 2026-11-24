import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type BlackboardStatus = "open" | "done";

export interface BlackboardItem {
  id: string;
  title: string;
  details?: string;
  status: BlackboardStatus;
  sourceMessageId?: string;
  sourceConversationId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface BlackboardFile {
  version: 1;
  items: BlackboardItem[];
}

export interface AddBlackboardInput {
  title: string;
  details?: string;
  sourceMessageId?: string;
  sourceConversationId?: string;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, "").trim().toLowerCase();
}

function createId(now: number): string {
  return `bb_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function isItem(value: unknown): value is BlackboardItem {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.title === "string" &&
      (record.status === "open" || record.status === "done") &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number",
  );
}

export class BlackboardStore {
  private readonly path: string;
  private readonly maxCompleted: number;
  private readonly now: () => number;
  private items: BlackboardItem[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string, maxCompleted = 5, now: () => number = Date.now) {
    this.path = path;
    this.maxCompleted = Math.max(1, maxCompleted);
    this.now = now;
  }

  async init(): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      this.items = file.items;
      this.pruneCompleted();
      await this.writeFile();
    });
  }

  list(): BlackboardItem[] {
    return structuredClone(this.items);
  }

  openItems(): BlackboardItem[] {
    return this.items
      .filter((item) => item.status === "open")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((item) => structuredClone(item));
  }

  completedItems(): BlackboardItem[] {
    return this.items
      .filter((item) => item.status === "done")
      .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
      .slice(0, this.maxCompleted)
      .map((item) => structuredClone(item));
  }

  async add(input: AddBlackboardInput): Promise<{ item: BlackboardItem; changed: boolean }> {
    return this.exclusive(async () => {
      const title = input.title.replace(/\s+/g, " ").trim();
      if (!title) {
        throw new Error("Blackboard item title must not be empty.");
      }
      const existing = this.items.find(
        (item) => item.status === "open" && normalizeTitle(item.title) === normalizeTitle(title),
      );
      if (existing) {
        const timestamp = this.now();
        existing.title = title;
        existing.details = input.details ?? existing.details;
        existing.sourceMessageId = input.sourceMessageId ?? existing.sourceMessageId;
        existing.sourceConversationId = input.sourceConversationId ?? existing.sourceConversationId;
        existing.updatedAt = timestamp;
        await this.writeFile();
        return { item: structuredClone(existing), changed: true };
      }

      const timestamp = this.now();
      const item: BlackboardItem = {
        id: createId(timestamp),
        title,
        details: input.details,
        status: "open",
        sourceMessageId: input.sourceMessageId,
        sourceConversationId: input.sourceConversationId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.items.push(item);
      this.pruneCompleted();
      await this.writeFile();
      return { item: structuredClone(item), changed: true };
    });
  }

  async complete(taskId: string): Promise<{ item: BlackboardItem; changed: boolean } | undefined> {
    return this.exclusive(async () => {
      const item = this.items.find((candidate) => candidate.id === taskId);
      if (!item || item.status === "done") {
        return undefined;
      }
      const timestamp = this.now();
      item.status = "done";
      item.completedAt = timestamp;
      item.updatedAt = timestamp;
      this.pruneCompleted();
      await this.writeFile();
      return { item: structuredClone(item), changed: true };
    });
  }

  render(): string {
    const open = this.openItems();
    const completed = this.completedItems();
    const lines = [
      "# 我的待办黑板",
      "",
      `更新时间：${new Date(this.now()).toISOString()}`,
      "",
      "## 未完成",
      "",
    ];
    if (open.length === 0) {
      lines.push("（暂无）");
    } else {
      open.forEach((item, index) => {
        lines.push(`${index + 1}. [ ] ${item.title}`);
        if (item.details) {
          lines.push(`   ${item.details}`);
        }
      });
    }
    lines.push("", `## 最近完成（最多 ${this.maxCompleted} 项）`, "");
    if (completed.length === 0) {
      lines.push("（暂无）");
    } else {
      completed.forEach((item) => {
        const date = item.completedAt ? new Date(item.completedAt).toISOString() : "未知时间";
        lines.push(`- [x] ${item.title}（${date}）`);
      });
    }
    return `${lines.join("\n")}\n`;
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readFile(): Promise<BlackboardFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (!raw.trim()) {
        return { version: 1, items: [] };
      }
      const parsed = JSON.parse(raw) as Partial<BlackboardFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.items) || !parsed.items.every(isItem)) {
        throw new Error(`Unsupported blackboard format: ${this.path}`);
      }
      return { version: 1, items: parsed.items as BlackboardItem[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, items: [] };
      }
      throw error;
    }
  }

  private pruneCompleted(): void {
    const completed = this.items
      .filter((item) => item.status === "done")
      .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0));
    const keep = new Set(completed.slice(0, this.maxCompleted).map((item) => item.id));
    this.items = this.items.filter((item) => item.status === "open" || keep.has(item.id));
  }

  private async writeFile(): Promise<void> {
    await mkdir(dirname(resolve(this.path)), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, items: this.items }, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temp, 0o600);
    await rename(temp, this.path);
    await chmod(this.path, 0o600);
  }
}
