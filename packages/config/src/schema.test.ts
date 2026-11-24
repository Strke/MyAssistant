import { describe, expect, it } from "vitest";
import { loadConfig } from "./schema";

describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.app.env).toBe("development");
    expect(config.app.logLevel).toBe("info");
    expect(config.model.provider).toBe("anthropic");
    expect(config.rag.topK).toBe(8);
    expect(config.dingtalk.enabled).toBe(false);
    expect(config.tasks.backend).toBe("local");
  });

  it("parses booleans and numbers from env strings", () => {
    const config = loadConfig({
      DINGTALK_ENABLED: "true",
      DINGTALK_CLIENT_ID: "client-id",
      DINGTALK_CLIENT_SECRET: "client-secret",
      RAG_TOP_K: "12",
      VAULT_AUTO_LOCK_MINUTES: "30",
    });
    expect(config.dingtalk.enabled).toBe(true);
    expect(config.rag.topK).toBe(12);
    expect(config.vault.autoLockMinutes).toBe(30);
  });

  it("rejects dingtalk enabled without credentials", () => {
    expect(() => loadConfig({ DINGTALK_ENABLED: "true" })).toThrow();
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ MODEL_API_KEY: "", RAG_DB_PATH: "" });
    expect(config.model.apiKey).toBeUndefined();
    expect(config.rag.dbPath).toBe("./data/assistant.db");
  });

  it("parses daemon and dingtalk hardening settings", () => {
    const config = loadConfig({
      DAEMON_ENABLED: "true",
      DAEMON_SOCKET_PATH: "/tmp/assistant.sock",
      DINGTALK_RATE_LIMIT_PER_MINUTE: "5",
      DINGTALK_SESSION_IDLE_MINUTES: "30",
      TASKS_CONCURRENCY: "3",
      TASKS_TIMEOUT_MINUTES: "10",
    });
    expect(config.daemon.enabled).toBe(true);
    expect(config.daemon.socketPath).toBe("/tmp/assistant.sock");
    expect(config.dingtalk.rateLimitPerMinute).toBe(5);
    expect(config.dingtalk.sessionIdleMinutes).toBe(30);
    expect(config.tasks.concurrency).toBe(3);
    expect(config.tasks.timeoutMinutes).toBe(10);
  });

  it("requires a URL for the http-a2a task backend", () => {
    expect(() => loadConfig({ TASKS_BACKEND: "http-a2a" })).toThrow(/TASKS_HTTP_URL/);
    const config = loadConfig({
      TASKS_BACKEND: "http-a2a",
      TASKS_HTTP_URL: "http://127.0.0.1:8787/tasks",
    });
    expect(config.tasks.httpUrl).toBe("http://127.0.0.1:8787/tasks");
  });

  it("parses DWS history configuration", () => {
    const config = loadConfig({
      DWS_ENABLED: "true",
      DWS_GATEWAY_URL: "https://dws-b.example",
      DWS_HISTORY_GROUPS: "cid-1, cid-2",
      DWS_PAGE_SIZE: "50",
      DWS_MAX_ITEMS_PER_SYNC: "1000",
    });
    expect(config.dws.enabled).toBe(true);
    expect(config.dws.gatewayUrl).toBe("https://dws-b.example");
    expect(config.dws.historyGroups).toEqual(["cid-1", "cid-2"]);
    expect(config.dws.pageSize).toBe(50);
    expect(config.dws.maxItemsPerSync).toBe(1000);
  });
});
