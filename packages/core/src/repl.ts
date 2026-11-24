import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "@myassistant/config";
import { createAssistantSession } from "./session";

const HELP_TEXT = `Commands:
  /help     Show this help
  /status   Show current session info
  /new      Start a new session
  /exit     Quit`;

function attachStream(session: AgentSession): () => void {
  return session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "tool_execution_start") {
      stdout.write(`\n[tool] ${event.toolName}\n`);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      stdout.write("\n");
    }
  });
}

function statusLine(session: AgentSession): string {
  const model = session.model ? `${session.model.provider}/${session.model.id}` : "unknown";
  return `session=${session.sessionId} model=${model} messages=${session.messages.length}`;
}

export async function runRepl(config: AppConfig): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  let current = await createAssistantSession({ config });
  let unsubscribe = attachStream(current.session);

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
        current = await createAssistantSession({ config });
        unsubscribe = attachStream(current.session);
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
  }
}
