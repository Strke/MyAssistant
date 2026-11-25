import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface SummaryEntry {
  summary: string;
  updatedAt: number;
}

interface SummaryFile {
  version: 1;
  conversations: Record<string, SummaryEntry>;
}

export class ConversationSummaryStore {
  private readonly path: string;
  private readonly now: () => number;
  private entries: Record<string, SummaryEntry> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  async init(): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      this.entries = file.conversations;
    });
  }

  async get(conversationId: string): Promise<string | undefined> {
    return this.exclusive(async () => this.entries[conversationId]?.summary);
  }

  async set(conversationId: string, summary: string): Promise<void> {
    const value = summary.trim();
    if (!value) {
      return;
    }
    await this.exclusive(async () => {
      this.entries[conversationId] = {
        summary: value,
        updatedAt: this.now(),
      };
      await this.writeFile();
    });
  }

  async update(
    conversationId: string,
    updater: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = await this.get(conversationId);
      const next = (await updater(current))?.trim();
      if (!next || next === current) {
        return current;
      }
      await this.set(conversationId, next);
      return next;
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(conversationId, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(conversationId) === tail) {
        this.queues.delete(conversationId);
      }
    }
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readFile(): Promise<SummaryFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (!raw.trim()) {
        return { version: 1, conversations: {} };
      }
      const parsed = JSON.parse(raw) as Partial<SummaryFile>;
      if (
        parsed.version !== 1 ||
        !parsed.conversations ||
        typeof parsed.conversations !== "object"
      ) {
        throw new Error(`Unsupported conversation summary format: ${this.path}`);
      }
      return { version: 1, conversations: parsed.conversations as Record<string, SummaryEntry> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, conversations: {} };
      }
      throw error;
    }
  }

  private async writeFile(): Promise<void> {
    await mkdir(dirname(resolve(this.path)), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    await writeFile(
      temp,
      `${JSON.stringify({ version: 1, conversations: this.entries }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(temp, 0o600);
    await rename(temp, this.path);
    await chmod(this.path, 0o600);
  }
}
