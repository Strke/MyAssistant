import { stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfigFromEnvFile } from "@myassistant/config";
import { ControlClient } from "./control-client";

interface TaskListItem {
  id: string;
  status: string;
  backend: string;
  description: string;
  createdAt: number;
  error?: string;
}

function usage(): void {
  stdout.write(`Usage: npm run assistant -- <command> [options]

Commands:
  status                          Show daemon status
  ping                            Check whether the daemon is reachable
  chat [text]                     Chat with the local session (interactive when text is omitted)
  task list [status]              List delegated tasks
  task check <taskId>             Show a delegated task
  task cancel <taskId>            Cancel a delegated task
  shutdown                        Stop the daemon

Options:
  --socket <path>                 Override DAEMON_SOCKET_PATH
  --conversation <id>             Local chat conversation id (default: default)
`);
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

function printTasks(data: unknown): void {
  if (!Array.isArray(data) || data.length === 0) {
    stdout.write("No tasks.\n");
    return;
  }
  for (const item of data as TaskListItem[]) {
    const created = new Date(item.createdAt).toISOString();
    stdout.write(
      `${item.id}\t${item.status}\t${item.backend}\t${created}\t${item.description.slice(0, 100)}\n`,
    );
  }
}

async function chatOnce(
  client: ControlClient,
  text: string,
  conversationId: string,
): Promise<void> {
  let streamed = false;
  const data = await client.request<{ text: string }>(
    { type: "chat", text, conversationId },
    (event) => {
      if (event.event === "delta") {
        streamed = true;
        stdout.write(event.text);
      } else {
        stderr.write(`[${event.text}]\n`);
      }
    },
    0,
  );
  if (streamed) {
    stdout.write("\n");
  } else if (data.text) {
    stdout.write(`${data.text}\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const socketOverride = takeOption(args, "--socket");
  const conversationId = takeOption(args, "--conversation") ?? "default";
  const command = args.shift();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  const config = loadConfigFromEnvFile();
  const client = new ControlClient({
    socketPath: socketOverride ?? config.daemon.socketPath,
  });

  try {
    await client.connect();

    switch (command) {
      case "ping": {
        const data = await client.request({ type: "ping" }, undefined, 10_000);
        stdout.write(`${JSON.stringify(data)}\n`);
        break;
      }
      case "status": {
        const data = await client.request({ type: "status" }, undefined, 10_000);
        stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        break;
      }
      case "shutdown": {
        const data = await client.request({ type: "shutdown" }, undefined, 10_000);
        stdout.write(`${JSON.stringify(data)}\n`);
        break;
      }
      case "chat": {
        const text = args.join(" ").trim();
        if (text) {
          await chatOnce(client, text, conversationId);
          break;
        }
        const rl = createInterface({ input: process.stdin, output: stdout });
        stdout.write("Type /exit to quit.\n");
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
            stdout.write("assistant> ");
            try {
              await chatOnce(client, input, conversationId);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              stderr.write(`\n${message}\n`);
            }
          }
        } finally {
          rl.close();
        }
        break;
      }
      case "task": {
        const subcommand = args.shift();
        if (subcommand === "list") {
          const data = await client.request(
            { type: "task.list", status: args[0] },
            undefined,
            10_000,
          );
          printTasks(data);
          break;
        }
        if (subcommand === "check") {
          const taskId = args[0];
          if (!taskId) {
            throw new Error("task check requires a task id.");
          }
          const data = await client.request({ type: "task.check", taskId }, undefined, 10_000);
          stdout.write(`${JSON.stringify(data, null, 2)}\n`);
          break;
        }
        if (subcommand === "cancel") {
          const taskId = args[0];
          if (!taskId) {
            throw new Error("task cancel requires a task id.");
          }
          const data = await client.request({ type: "task.cancel", taskId }, undefined, 10_000);
          stdout.write(`${JSON.stringify(data)}\n`);
          break;
        }
        usage();
        process.exitCode = 1;
        break;
      }
      default:
        usage();
        process.exitCode = 1;
    }
  } finally {
    client.close();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  process.exitCode = 1;
}
