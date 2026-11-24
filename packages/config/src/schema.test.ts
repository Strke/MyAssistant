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
});
