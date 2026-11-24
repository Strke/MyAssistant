import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import type { AgentTask, TaskExecutor } from "../types";

export interface PiRpcExecutorOptions {
  provider: string;
  model: string;
  apiKey?: string;
  cliPath?: string;
  cwd?: string;
  thinkingLevel?: string;
  env?: Record<string, string>;
}

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  mistral: "MISTRAL_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

function resolveCliPath(explicit?: string): string {
  const path = explicit ?? join(getPackageDir(), "dist", "bundle", "cli.js");
  if (!existsSync(path)) {
    throw new Error(`Pi CLI not found at ${path}. Run npm install or set TASKS_PI_RPC_CLI.`);
  }
  return path;
}

/**
 * Runs each task in an isolated Pi CLI process via RPC mode. The process gets
 * a fresh session and the same provider/model configuration as the assistant.
 */
export class PiRpcExecutor implements TaskExecutor {
  private readonly options: PiRpcExecutorOptions;

  constructor(options: PiRpcExecutorOptions) {
    this.options = options;
  }

  async run(task: AgentTask, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const env = { ...this.options.env };
    if (this.options.apiKey) {
      const envName = PROVIDER_API_KEY_ENV[this.options.provider];
      if (envName) {
        env[envName] = this.options.apiKey;
      }
    }

    const client = new RpcClient({
      cliPath: resolveCliPath(this.options.cliPath),
      cwd: this.options.cwd,
      provider: this.options.provider,
      model: this.options.model,
      env,
      args: [
        "--no-session",
        ...(this.options.thinkingLevel && this.options.thinkingLevel !== "off"
          ? ["--thinking", this.options.thinkingLevel]
          : []),
      ],
    });

    const onAbort = () => {
      void client.abort().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await client.start();
      const disposition = await client.promptAndWait(task.description);
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      const failed = disposition.find(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          (event.message.stopReason === "error" || event.message.stopReason === "aborted"),
      );
      if (failed) {
        throw new Error(
          failed.type === "message_end" && failed.message.role === "assistant"
            ? `Pi RPC task failed: ${failed.message.errorMessage ?? "model returned an error"}`
            : "Pi RPC task failed.",
        );
      }
      return (await client.getLastAssistantText())?.trim() ?? "";
    } finally {
      signal.removeEventListener("abort", onAbort);
      await client.stop().catch(() => undefined);
    }
  }
}

export function createPiRpcExecutor(options: PiRpcExecutorOptions): PiRpcExecutor {
  return new PiRpcExecutor(options);
}
