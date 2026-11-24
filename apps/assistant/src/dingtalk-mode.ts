import { createDingTalkChannel } from "@myassistant/channel-dingtalk";
import type { AppConfig } from "@myassistant/config";
import type { ConversationRecord, ToolDefinition } from "@myassistant/core";
import { createDingTalkRunner } from "./dingtalk-runner";

export interface DingTalkModeOptions {
  config: AppConfig;
  customTools: ToolDefinition[];
  onMessage?: (record: ConversationRecord) => Promise<void>;
}

export async function runDingTalkMode(options: DingTalkModeOptions): Promise<void> {
  const { config } = options;
  if (!config.dingtalk.clientId || !config.dingtalk.clientSecret) {
    throw new Error("DingTalk is enabled but DINGTALK_CLIENT_ID/CLIENT_SECRET are missing.");
  }

  const channel = createDingTalkChannel({
    clientId: config.dingtalk.clientId,
    clientSecret: config.dingtalk.clientSecret,
    robotCode: config.dingtalk.robotCode,
    debug: config.app.env !== "production",
    onError: (error) => {
      process.stderr.write(`[dingtalk] ${error.message}\n`);
    },
  });
  const runner = createDingTalkRunner({
    config,
    channel,
    customTools: options.customTools,
    onMessage: options.onMessage,
  });

  let resolveShutdown: () => void = () => undefined;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const onSignal = () => resolveShutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await runner.start();
    process.stdout.write(
      `[assistant] dingtalk stream connected (robot: ${config.dingtalk.robotCode ?? "default"})\n`,
    );
    await shutdown;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runner.stop();
  }
}
