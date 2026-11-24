import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "@myassistant/config";
import { DEFAULT_ASSISTANT_SYSTEM_PROMPT } from "./prompt";

export interface AssistantSession {
  session: AgentSession;
  modelRuntime: ModelRuntime;
}

export interface CreateAssistantSessionOptions {
  config: AppConfig;
  customTools?: ToolDefinition[];
  sessionDir?: string;
  /** Start a fresh session instead of continuing the most recent one. */
  newSession?: boolean;
  /** Replace the configured system prompt, for example for a task sub-agent. */
  systemPrompt?: string;
  /** Tool names to disable for this session. */
  excludeTools?: string[];
}

async function loadSystemPrompt(config: AppConfig, override?: string): Promise<string> {
  if (override) {
    return override;
  }
  const file = config.agent.systemPromptFile;
  if (!file) {
    return DEFAULT_ASSISTANT_SYSTEM_PROMPT;
  }
  try {
    return await readFile(resolve(file), "utf8");
  } catch {
    process.stderr.write(`[assistant] system prompt file not found: ${file}\n`);
    return DEFAULT_ASSISTANT_SYSTEM_PROMPT;
  }
}

export async function createAssistantSession(
  options: CreateAssistantSessionOptions,
): Promise<AssistantSession> {
  const { config } = options;
  const cwd = resolve(config.agent.workspace);
  const modelRuntime = await ModelRuntime.create();

  if (config.model.apiKey) {
    await modelRuntime.setRuntimeApiKey(config.model.provider, config.model.apiKey);
  }

  const model = modelRuntime.getModel(config.model.provider, config.model.id);
  if (!model) {
    const available = await modelRuntime.getAvailable();
    const ids = available.map((item) => `${item.provider}/${item.id}`).join(", ");
    throw new Error(
      `Model "${config.model.provider}/${config.model.id}" is not available. ` +
        (ids
          ? `Available models: ${ids}`
          : "No model credentials configured. Set MODEL_API_KEY or run `pi` and use `/login`."),
    );
  }

  const systemPrompt = await loadSystemPrompt(config, options.systemPrompt);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const sessionManager = options.newSession
    ? SessionManager.create(cwd, options.sessionDir)
    : SessionManager.continueRecent(cwd, options.sessionDir);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel: config.model.thinkingLevel,
    resourceLoader,
    sessionManager,
    customTools: options.customTools,
    excludeTools: options.excludeTools,
  });

  if (modelFallbackMessage) {
    process.stderr.write(`[assistant] ${modelFallbackMessage}\n`);
  }

  return { session, modelRuntime };
}
