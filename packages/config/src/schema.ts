import { existsSync } from "node:fs";
import { z } from "zod";

const envBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  return value;
}, z.boolean());

const optionalString = z.string().min(1).optional();

const envCsv = z.preprocess((value) => {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value;
}, z.array(z.string()).default([]));

export const appConfigSchema = z.object({
  app: z.object({
    env: z.enum(["development", "test", "production"]).default("development"),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  }),
  model: z.object({
    provider: z.string().min(1).default("anthropic"),
    id: z.string().min(1).default("claude-sonnet-4-6"),
    apiKey: optionalString,
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .default("off"),
  }),
  agent: z.object({
    workspace: z.string().min(1).default("."),
    systemPromptFile: optionalString,
  }),
  dingtalk: z
    .object({
      enabled: envBoolean.default(false),
      clientId: optionalString,
      clientSecret: optionalString,
      robotCode: optionalString,
      rateLimitPerMinute: z.coerce.number().int().nonnegative().default(20),
      maxMessageChars: z.coerce.number().int().positive().default(8_000),
      sessionIdleMinutes: z.coerce.number().int().positive().default(120),
      maxSessions: z.coerce.number().int().positive().default(100),
    })
    .superRefine((value, ctx) => {
      if (value.enabled && (!value.clientId || !value.clientSecret)) {
        ctx.addIssue({
          code: "custom",
          path: ["clientId", "clientSecret"],
          message:
            "DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET are required when DingTalk is enabled",
        });
      }
    }),
  rag: z.object({
    enabled: envBoolean.default(true),
    dbPath: z.string().min(1).default("./data/assistant.db"),
    topK: z.coerce.number().int().positive().default(8),
    embedding: z.object({
      provider: z.string().min(1).default("openai"),
      model: z.string().min(1).default("text-embedding-3-large"),
      dimensions: z.coerce.number().int().positive().default(3072),
      apiKey: optionalString,
      baseUrl: z.string().min(1).default("https://api.openai.com/v1"),
    }),
  }),
  vault: z.object({
    path: z.string().min(1).default("./data/vault.enc"),
    keychainService: z.string().min(1).default("com.myassistant.vault"),
    keychainAccount: z.string().min(1).default("default"),
    autoLockMinutes: z.coerce.number().int().positive().default(15),
  }),
  daemon: z.object({
    enabled: envBoolean.default(false),
    socketPath: z.string().min(1).default("./data/assistant.sock"),
    localSessionDir: z.string().min(1).default("./data/local-sessions"),
    localSessionIdleMinutes: z.coerce.number().int().positive().default(120),
  }),
  dws: z.object({
    enabled: envBoolean.default(false),
    gatewayUrl: z.string().min(1).default("http://127.0.0.1:8787"),
    gatewayToken: optionalString,
    historyGroups: envCsv,
    historyIntervalMinutes: z.coerce.number().int().positive().default(60),
    historyOverlapMinutes: z.coerce.number().int().nonnegative().default(10),
    historyBackfillDays: z.coerce.number().int().positive().default(30),
    requestTimeoutSeconds: z.coerce.number().int().positive().default(120),
    pageSize: z.coerce.number().int().positive().max(500).default(100),
    maxItemsPerSync: z.coerce.number().int().positive().default(5_000),
  }),
  review: z.object({
    enabled: envBoolean.default(false),
    host: z.string().min(1).default("127.0.0.1"),
    port: z.coerce.number().int().positive().max(65_535).default(8788),
    token: optionalString,
    topK: z.coerce.number().int().positive().max(50).default(8),
    maxContentChars: z.coerce.number().int().positive().default(8_000),
    timeoutSeconds: z.coerce.number().int().positive().default(90),
    autoReply: envBoolean.default(false),
    blackboardEnabled: envBoolean.default(false),
    blackboardPath: z.string().min(1).default("./data/blackboard.json"),
    blackboardGroupId: optionalString,
    maxCompleted: z.coerce.number().int().positive().default(5),
  }),
  tasks: z
    .object({
      enabled: envBoolean.default(true),
      backend: z.enum(["local", "pi-subagent", "pi-rpc", "http-a2a"]).default("local"),
      path: z.string().min(1).default("./data/tasks.json"),
      sessionDir: z.string().min(1).default("./data/task-sessions"),
      concurrency: z.coerce.number().int().positive().max(16).default(2),
      timeoutMinutes: z.coerce.number().int().positive().default(30),
      maxRecords: z.coerce.number().int().positive().default(500),
      httpUrl: optionalString,
      piRpcCli: optionalString,
    })
    .superRefine((value, ctx) => {
      if (value.backend === "http-a2a" && !value.httpUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["httpUrl"],
          message: "TASKS_HTTP_URL is required when TASKS_BACKEND=http-a2a",
        });
      }
    }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = {
    app: {
      env: clean(env.NODE_ENV),
      logLevel: clean(env.LOG_LEVEL),
    },
    model: {
      provider: clean(env.MODEL_PROVIDER),
      id: clean(env.MODEL_ID),
      apiKey: clean(env.MODEL_API_KEY),
      thinkingLevel: clean(env.MODEL_THINKING_LEVEL),
    },
    agent: {
      workspace: clean(env.AGENT_WORKSPACE),
      systemPromptFile: clean(env.AGENT_SYSTEM_PROMPT_FILE),
    },
    dingtalk: {
      enabled: clean(env.DINGTALK_ENABLED),
      clientId: clean(env.DINGTALK_CLIENT_ID),
      clientSecret: clean(env.DINGTALK_CLIENT_SECRET),
      robotCode: clean(env.DINGTALK_ROBOT_CODE),
      rateLimitPerMinute: clean(env.DINGTALK_RATE_LIMIT_PER_MINUTE),
      maxMessageChars: clean(env.DINGTALK_MAX_MESSAGE_CHARS),
      sessionIdleMinutes: clean(env.DINGTALK_SESSION_IDLE_MINUTES),
      maxSessions: clean(env.DINGTALK_MAX_SESSIONS),
    },
    rag: {
      enabled: clean(env.RAG_ENABLED),
      dbPath: clean(env.RAG_DB_PATH),
      topK: clean(env.RAG_TOP_K),
      embedding: {
        provider: clean(env.RAG_EMBEDDING_PROVIDER),
        model: clean(env.RAG_EMBEDDING_MODEL),
        dimensions: clean(env.RAG_EMBEDDING_DIMENSIONS),
        apiKey: clean(env.RAG_EMBEDDING_API_KEY),
        baseUrl: clean(env.RAG_EMBEDDING_BASE_URL),
      },
    },
    vault: {
      path: clean(env.VAULT_PATH),
      keychainService: clean(env.VAULT_KEYCHAIN_SERVICE),
      keychainAccount: clean(env.VAULT_KEYCHAIN_ACCOUNT),
      autoLockMinutes: clean(env.VAULT_AUTO_LOCK_MINUTES),
    },
    daemon: {
      enabled: clean(env.DAEMON_ENABLED),
      socketPath: clean(env.DAEMON_SOCKET_PATH),
      localSessionDir: clean(env.DAEMON_LOCAL_SESSION_DIR),
      localSessionIdleMinutes: clean(env.DAEMON_LOCAL_SESSION_IDLE_MINUTES),
    },
    dws: {
      enabled: clean(env.DWS_ENABLED),
      gatewayUrl: clean(env.DWS_GATEWAY_URL),
      gatewayToken: clean(env.DWS_GATEWAY_TOKEN),
      historyGroups: clean(env.DWS_HISTORY_GROUPS),
      historyIntervalMinutes: clean(env.DWS_HISTORY_INTERVAL_MINUTES),
      historyOverlapMinutes: clean(env.DWS_HISTORY_OVERLAP_MINUTES),
      historyBackfillDays: clean(env.DWS_HISTORY_BACKFILL_DAYS),
      requestTimeoutSeconds: clean(env.DWS_REQUEST_TIMEOUT_SECONDS),
      pageSize: clean(env.DWS_PAGE_SIZE),
      maxItemsPerSync: clean(env.DWS_MAX_ITEMS_PER_SYNC),
    },
    review: {
      enabled: clean(env.REVIEW_ENABLED),
      host: clean(env.REVIEW_HOST),
      port: clean(env.REVIEW_PORT),
      token: clean(env.REVIEW_TOKEN),
      topK: clean(env.REVIEW_TOP_K),
      maxContentChars: clean(env.REVIEW_MAX_CONTENT_CHARS),
      timeoutSeconds: clean(env.REVIEW_TIMEOUT_SECONDS),
      autoReply: clean(env.REVIEW_AUTO_REPLY),
      blackboardEnabled: clean(env.BLACKBOARD_ENABLED),
      blackboardPath: clean(env.BLACKBOARD_PATH),
      blackboardGroupId: clean(env.BLACKBOARD_GROUP_ID),
      maxCompleted: clean(env.BLACKBOARD_MAX_COMPLETED),
    },
    tasks: {
      enabled: clean(env.TASKS_ENABLED),
      backend: clean(env.TASKS_BACKEND),
      path: clean(env.TASKS_PATH),
      sessionDir: clean(env.TASKS_SESSION_DIR),
      concurrency: clean(env.TASKS_CONCURRENCY),
      timeoutMinutes: clean(env.TASKS_TIMEOUT_MINUTES),
      maxRecords: clean(env.TASKS_MAX_RECORDS),
      httpUrl: clean(env.TASKS_HTTP_URL),
      piRpcCli: clean(env.TASKS_PI_RPC_CLI),
    },
  };

  return appConfigSchema.parse(raw);
}

export function loadConfigFromEnvFile(
  path = ".env",
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
  return loadConfig(env);
}
