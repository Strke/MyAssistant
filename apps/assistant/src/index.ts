import { createAssetTools } from "@myassistant/assets";
import { loadConfigFromEnvFile } from "@myassistant/config";
import { createLogger, describeRuntime, runRepl, type ToolDefinition } from "@myassistant/core";
import {
  type ChatMessageRecord,
  createEmbedder,
  createMemorySearchTool,
  openRagStore,
} from "@myassistant/rag";
import { createTaskTools, type TaskManager } from "@myassistant/tasks";
import { createVaultTools, type Vault } from "@myassistant/vault";
import { openAssetStore } from "./asset-runtime";
import { runDaemon } from "./daemon";
import { runDingTalkMode } from "./dingtalk-mode";
import { openTaskManager } from "./task-runtime";
import { openVault } from "./vault-runtime";

const config = loadConfigFromEnvFile();
const logger = createLogger({ level: config.app.logLevel });
logger.info({ runtime: describeRuntime(config) }, "assistant starting");
const daemonMode = process.argv.includes("--daemon") || config.daemon.enabled;

const customTools: ToolDefinition[] = [];
let store: ReturnType<typeof openRagStore> | undefined;

if (config.rag.enabled) {
  try {
    const embedder = createEmbedder(config.rag.embedding);
    store = openRagStore({ dbPath: config.rag.dbPath, embedder });
    customTools.push(createMemorySearchTool(store, config.rag.topK) as ToolDefinition);
    logger.info(
      {
        path: config.rag.dbPath,
        provider: config.rag.embedding.provider,
        model: config.rag.embedding.model,
      },
      "rag enabled",
    );
  } catch (error) {
    logger.warn({ err: error }, "rag disabled");
  }
}

const ragStore = store;

let vault: Vault | undefined;
try {
  vault = openVault(config);
  customTools.push(...createVaultTools(vault));
  logger.info({ path: config.vault.path }, "vault enabled");
} catch (error) {
  logger.warn({ err: error }, "vault disabled");
}

const activeVault = vault;

if (config.assets.enabled) {
  try {
    const inventory = await openAssetStore(config);
    customTools.push(...createAssetTools(inventory));
    logger.info({ path: config.assets.path }, "asset inventory enabled");
  } catch (error) {
    logger.warn({ err: error }, "asset inventory disabled");
  }
}

let taskManager: TaskManager | undefined;
try {
  taskManager = await openTaskManager(config, {
    onError: (error) => {
      logger.error({ err: error }, "task manager error");
    },
    logger,
  });
  if (taskManager) {
    logger.info(
      {
        backend: config.tasks.backend,
        path: config.tasks.path,
        concurrency: config.tasks.concurrency,
      },
      "tasks enabled",
    );
  }
} catch (error) {
  logger.warn({ err: error }, "tasks disabled");
}

const activeTaskManager = taskManager;

const onMessage = ragStore ? (record: ChatMessageRecord) => ragStore.addMessage(record) : undefined;

try {
  if (daemonMode) {
    await runDaemon({
      config,
      customTools,
      taskManager: activeTaskManager,
      ragStore,
      onMessage,
      logger,
    });
  } else if (config.dingtalk.enabled) {
    await runDingTalkMode({
      config,
      customTools,
      taskManager: activeTaskManager,
      onMessage,
      logger,
    });
  } else {
    const localTools = [
      ...customTools,
      ...(activeTaskManager ? createTaskTools(activeTaskManager) : []),
    ];
    await runRepl(config, { customTools: localTools, onMessage, logger });
  }
} finally {
  await activeTaskManager?.close();
  await ragStore?.close();
  await activeVault?.close();
}
