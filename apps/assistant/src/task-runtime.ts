import { resolve } from "node:path";
import type { AppConfig } from "@myassistant/config";
import { createPiSubagentExecutor } from "@myassistant/core";
import {
  createHttpTaskExecutor,
  createPiRpcExecutor,
  JsonTaskStore,
  type TaskExecutor,
  TaskManager,
} from "@myassistant/tasks";

export interface OpenTaskManagerOptions {
  onError?: (error: unknown) => void;
}

function createExecutor(config: AppConfig): TaskExecutor {
  switch (config.tasks.backend) {
    case "local":
    case "pi-subagent":
      return createPiSubagentExecutor(config, {
        sessionRoot: resolve(config.tasks.sessionDir),
      });
    case "pi-rpc":
      return createPiRpcExecutor({
        provider: config.model.provider,
        model: config.model.id,
        apiKey: config.model.apiKey,
        cliPath: config.tasks.piRpcCli,
        cwd: resolve(config.agent.workspace),
        thinkingLevel: config.model.thinkingLevel,
      });
    case "http-a2a": {
      if (!config.tasks.httpUrl) {
        throw new Error("TASKS_HTTP_URL is required when TASKS_BACKEND=http-a2a.");
      }
      return createHttpTaskExecutor({ baseUrl: config.tasks.httpUrl });
    }
  }
}

export async function openTaskManager(
  config: AppConfig,
  options: OpenTaskManagerOptions = {},
): Promise<TaskManager | undefined> {
  if (!config.tasks.enabled) {
    return undefined;
  }

  const manager = new TaskManager({
    store: new JsonTaskStore(resolve(config.tasks.path)),
    executor: createExecutor(config),
    backend: config.tasks.backend,
    concurrency: config.tasks.concurrency,
    timeoutMs: config.tasks.timeoutMinutes * 60_000,
    maxRecords: config.tasks.maxRecords,
    onError: options.onError,
  });
  await manager.init();
  return manager;
}
