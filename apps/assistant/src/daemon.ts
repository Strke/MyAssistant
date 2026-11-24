import type { AppConfig } from "@myassistant/config";
import { describeRuntime, type Logger, type ToolDefinition } from "@myassistant/core";
import type { ChatMessageRecord, RagStore } from "@myassistant/rag";
import { type AgentTaskStatus, createTaskTools, type TaskManager } from "@myassistant/tasks";
import { createControlServer } from "./control-server";
import { createDingTalkService, type DingTalkService } from "./dingtalk-service";
import { createLocalChatService } from "./local-chat";
import { createReviewServer, type ReviewServer } from "./review-server";

export interface DaemonOptions {
  config: AppConfig;
  customTools: ToolDefinition[];
  taskManager?: TaskManager;
  ragStore?: RagStore;
  onMessage?: (record: ChatMessageRecord) => Promise<void>;
  logger: Logger;
}

const STATUSES: AgentTaskStatus[] = ["pending", "running", "succeeded", "failed", "cancelled"];

function parseStatus(value: string | undefined): AgentTaskStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (!STATUSES.includes(value as AgentTaskStatus)) {
    throw new Error(`Unknown task status "${value}". Use one of: ${STATUSES.join(", ")}.`);
  }
  return value as AgentTaskStatus;
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { config, logger } = options;
  const startedAt = Date.now();
  const taskManager = options.taskManager;
  const localTools = [...options.customTools, ...(taskManager ? createTaskTools(taskManager) : [])];
  const localChat = createLocalChatService({
    config,
    customTools: localTools,
    onMessage: options.onMessage,
    logger,
    sessionDir: config.daemon.localSessionDir,
    idleMs: config.daemon.localSessionIdleMinutes * 60_000,
  });

  let dingtalk: DingTalkService | undefined;
  if (config.dingtalk.enabled) {
    dingtalk = createDingTalkService({
      config,
      customTools: options.customTools,
      taskManager,
      onMessage: options.onMessage,
      logger,
    });
  }

  let review: ReviewServer | undefined;
  if (config.review.enabled) {
    if (!options.ragStore) {
      logger.warn("review server is enabled but RAG is unavailable; review server not started");
    } else {
      review = await createReviewServer({
        config,
        store: options.ragStore,
        logger,
      });
    }
  }

  let resolveShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const control = createControlServer({
    socketPath: config.daemon.socketPath,
    logger,
    handlers: {
      async status() {
        return {
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          runtime: { ...describeRuntime(config), daemon: "enabled" as const },
          socketPath: config.daemon.socketPath,
          dingtalk: config.dingtalk.enabled ? "enabled" : "disabled",
          localSessions: localChat.sessionCount(),
          tasks: taskManager ? await taskManager.counts() : undefined,
        };
      },
      async chat(requestId, text, conversationId, emit, signal) {
        return localChat.chat(
          conversationId ?? "default",
          text,
          (eventName, delta) =>
            emit({ id: requestId, type: "event", event: eventName, text: delta }),
          signal,
        );
      },
      async taskList(status) {
        if (!taskManager) {
          return [];
        }
        const tasks = await taskManager.list(parseStatus(status));
        return tasks.slice(0, 50).map((task) => ({
          id: task.id,
          status: task.status,
          backend: task.backend,
          description: task.description,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          error: task.error,
        }));
      },
      async taskCheck(taskId) {
        if (!taskManager) {
          throw new Error("Task delegation is disabled.");
        }
        return taskManager.poll(taskId);
      },
      async taskCancel(taskId) {
        if (!taskManager) {
          throw new Error("Task delegation is disabled.");
        }
        return taskManager.cancel(taskId);
      },
      shutdown() {
        resolveShutdown();
      },
    },
  });

  const sweepTimer = setInterval(() => localChat.sweepIdleSessions(), 60_000);
  sweepTimer.unref?.();
  const onSignal = () => resolveShutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await control.start();
    await dingtalk?.start();
    await review?.start();
    logger.info(
      {
        socketPath: config.daemon.socketPath,
        dingtalk: config.dingtalk.enabled,
        review: config.review.enabled,
      },
      "daemon ready",
    );
    await shutdownRequested;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    clearInterval(sweepTimer);
    await review?.stop();
    await dingtalk?.stop();
    await control.stop();
    localChat.dispose();
    logger.info("daemon stopped");
  }
}
