import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ReplyBlock {
  text: string;
  repliedAt: number;
  messageIds: string[];
}

interface BlockFile {
  version: 1;
  conversations: Record<string, ReplyBlock>;
}

function isBlock(value: unknown): value is ReplyBlock {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.text === "string" &&
    typeof record.repliedAt === "number" &&
    Array.isArray(record.messageIds) &&
    record.messageIds.every((id) => typeof id === "string")
  );
}

export class ReplyBlockStore {
  private readonly path: string;
  private readonly now: () => number;
  private entries: Record<string, ReplyBlock> = {};
  private queue: Promise<unknown> = Promise.resolve();

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

  get(conversationId: string): ReplyBlock | undefined {
    const block = this.entries[conversationId];
    return block ? structuredClone(block) : undefined;
  }

  async set(conversationId: string, text: string, messageIds: string[]): Promise<void> {
    const value = text.trim();
    if (!value) {
      return;
    }
    await this.exclusive(async () => {
      this.entries[conversationId] = {
        text: value,
        repliedAt: this.now(),
        messageIds: [...new Set(messageIds)],
      };
      await this.writeFile();
    });
  }

  async extend(conversationId: string, messageIds: string[]): Promise<void> {
    const block = this.entries[conversationId];
    if (!block || messageIds.length === 0) {
      return;
    }
    await this.exclusive(async () => {
      const current = this.entries[conversationId];
      if (!current) {
        return;
      }
      current.messageIds = [...new Set([...current.messageIds, ...messageIds])];
      await this.writeFile();
    });
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readFile(): Promise<BlockFile> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (!raw.trim()) {
        return { version: 1, conversations: {} };
      }
      const parsed = JSON.parse(raw) as Partial<BlockFile>;
      if (
        parsed.version !== 1 ||
        !parsed.conversations ||
        typeof parsed.conversations !== "object"
      ) {
        throw new Error(`Unsupported reply block format: ${this.path}`);
      }
      const conversations: Record<string, ReplyBlock> = {};
      for (const [conversationId, block] of Object.entries(parsed.conversations)) {
        if (isBlock(block)) {
          conversations[conversationId] = block;
        }
      }
      return { version: 1, conversations };
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
