import { loadConfigFromEnvFile } from "@myassistant/config";
import { describeRuntime, runRepl, type ToolDefinition } from "@myassistant/core";
import { createEmbedder, createMemorySearchTool, openRagStore } from "@myassistant/rag";

const config = loadConfigFromEnvFile();
process.stdout.write(`[assistant] config: ${JSON.stringify(describeRuntime(config))}\n`);

const customTools: ToolDefinition[] = [];
let store: ReturnType<typeof openRagStore> | undefined;

if (config.rag.enabled) {
  try {
    const embedder = createEmbedder(config.rag.embedding);
    store = openRagStore({ dbPath: config.rag.dbPath, embedder });
    customTools.push(createMemorySearchTool(store, config.rag.topK) as ToolDefinition);
    process.stdout.write(
      `[assistant] rag: ${config.rag.dbPath} (${config.rag.embedding.provider}/${config.rag.embedding.model})\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[assistant] rag disabled: ${message}\n`);
  }
}

const ragStore = store;

try {
  await runRepl(config, {
    customTools,
    onMessage: ragStore ? (record) => ragStore.addMessage(record) : undefined,
  });
} finally {
  await ragStore?.close();
}
