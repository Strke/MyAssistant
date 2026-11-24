import { createDingTalkChannel } from "@myassistant/channel-dingtalk";
import type { AppConfig } from "@myassistant/config";
import type { ConversationRecord, Logger, ToolDefinition } from "@myassistant/core";
import { createTaskTools, type TaskManager } from "@myassistant/tasks";
import { createDingTalkRunner } from "./dingtalk-runner";
import { formatTaskNotification } from "./task-notifications";

export interface DingTalkServiceOptions {
  config: AppConfig;
  customTools: ToolDefinition[];
  taskManager?: TaskManager;
  onMessage?: (record: ConversationRecord) => Promise<void>;
  logger?: Logger;
}

export interface DingTalkService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDingTalkService(options: DingTalkServiceOptions): DingTalkService {
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
      options.logger?.error({ err: error }, "dingtalk channel error");
    },
  });

  const taskManager = options.taskManager;
  const unsubscribeTask = taskManager?.onUpdate(({ task, previousStatus }) => {
    if (task.notify?.channel !== "dingtalk") {
      return;
    }
    if (task.status === previousStatus) {
      return;
    }
    const text = formatTaskNotification(task);
    if (!text) {
      return;
    }
    void channel
      .send({ conversationId: task.notify.conversationId, text })
      .catch((error: unknown) => {
        options.logger?.error({ err: error }, "failed to push task notification");
      });
  });

  const runner = createDingTalkRunner({
    config,
    channel,
    customTools: (conversationId) => [
      ...options.customTools,
      ...(taskManager ? createTaskTools(taskManager, { channel: "dingtalk", conversationId }) : []),
    ],
    onMessage: options.onMessage,
    logger: options.logger,
    rateLimitPerMinute: config.dingtalk.rateLimitPerMinute,
    maxMessageChars: config.dingtalk.maxMessageChars,
    sessionIdleMs: config.dingtalk.sessionIdleMinutes * 60_000,
    maxSessions: config.dingtalk.maxSessions,
  });

  return {
    async start() {
      await runner.start();
      options.logger?.info(
        { robot: config.dingtalk.robotCode ?? "default" },
        "dingtalk stream connected",
      );
    },
    async stop() {
      unsubscribeTask?.();
      await runner.stop();
    },
  };
}
