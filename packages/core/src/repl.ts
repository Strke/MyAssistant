import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "@myassistant/config";
import type { Logger } from "./logging";
import { createAssistantSession } from "./session";

export interface ConversationRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  channel: string;
  sender?: string;
  content: string;
  createdAt: number;
}

export interface ReplOptions {
  customTools?: ToolDefinition[];
  onMessage?: (record: ConversationRecord) => Promise<void>;
  channel?: string;
  logger?: Logger;
}

const HELP_TEXT = `Commands:
  /help     Show this help
  /status   Show current session info
  /new      Start a new session
  /exit     Quit`;

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push(candidate.text);
    }
  }
  return parts.join("\n");
}

function toRecord(
  sessionId: string,
  message: unknown,
  channel: string,
): ConversationRecord | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const candidate = message as { role?: unknown; content?: unknown; timestamp?: unknown };
  if (candidate.role !== "user" && candidate.role !== "assistant") {
    return undefined;
  }

  const content = extractText(candidate.content);
  if (!content.trim()) {
    return undefined;
  }

  const createdAt = typeof candidate.timestamp === "number" ? candidate.timestamp : Date.now();
  return {
    id: `${sessionId}:${candidate.role}:${createdAt}`,
    conversationId: sessionId,
    role: candidate.role,
    channel,
    sender: candidate.role,
    content,
    createdAt,
  };
}

function attachStream(
  session: AgentSession,
  channel: string,
  onMessage: ((record: ConversationRecord) => Promise<void>) | undefined,
  enqueue: (task: () => Promise<void>) => void,
): () => void {
  return session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      stdout.write(`\n[tool] ${event.toolName}\n`);
    }
    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        stdout.write("\n");
      }
      if (onMessage) {
        const record = toRecord(session.sessionId, event.message, channel);
        if (record) {
          enqueue(() => onMessage(record));
        }
      }
    }
  });
}

function statusLine(session: AgentSession): string {
  const model = session.model ? `${session.model.provider}/${session.model.id}` : "unknown";
  return `session=${session.sessionId} model=${model} messages=${session.messages.length}`;
}

export async function runRepl(config: AppConfig, options: ReplOptions = {}): Promise<void> {
  const channel = options.channel ?? "local";
  const rl = createInterface({ input: stdin, output: stdout });

  let pending: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    pending = pending.then(task).catch((error) => {
      options.logger?.error({ err: error }, "failed to persist conversation message");
    });
  };

  const createSession = (newSession = false) =>
    createAssistantSession({
      config,
      customTools: options.customTools,
      newSession,
      logger: options.logger,
    });

  let current = await createSession();
  let unsubscribe = attachStream(current.session, channel, options.onMessage, enqueue);

  stdout.write(`[assistant] ${statusLine(current.session)}\nType /help for commands.\n`);

  try {
    while (true) {
      let input: string;
      try {
        input = (await rl.question("you> ")).trim();
      } catch {
        break;
      }

      if (!input) {
        continue;
      }
      if (input === "/exit" || input === "/quit") {
        break;
      }
      if (input === "/help") {
        stdout.write(`${HELP_TEXT}\n`);
        continue;
      }
      if (input === "/status") {
        stdout.write(`${statusLine(current.session)}\n`);
        continue;
      }
      if (input === "/new") {
        unsubscribe();
        current.session.dispose();
        current = await createSession(true);
        unsubscribe = attachStream(current.session, channel, options.onMessage, enqueue);
        stdout.write(`[assistant] new session ${current.session.sessionId}\n`);
        continue;
      }

      try {
        stdout.write("assistant> ");
        await current.session.prompt(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stdout.write(`\n[error] ${message}\n`);
      }
    }
  } finally {
    unsubscribe();
    current.session.dispose();
    rl.close();
    await pending;
  }
}
