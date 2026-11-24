import type { AppConfig } from "@myassistant/config";
import type { ConversationRecord, Logger, ToolDefinition } from "@myassistant/core";
import type { TaskManager } from "@myassistant/tasks";
import { createDingTalkService } from "./dingtalk-service";

export interface DingTalkModeOptions {
  config: AppConfig;
  customTools: ToolDefinition[];
  taskManager?: TaskManager;
  onMessage?: (record: ConversationRecord) => Promise<void>;
  logger?: Logger;
}

export async function runDingTalkMode(options: DingTalkModeOptions): Promise<void> {
  const service = createDingTalkService(options);

  let resolveShutdown: () => void = () => undefined;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const onSignal = () => resolveShutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await service.start();
    await shutdown;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await service.stop();
  }
}
