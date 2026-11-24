import { loadConfig } from "@myassistant/config";
import { describe, expect, it } from "vitest";
import { describeRuntime } from "./runtime";

describe("describeRuntime", () => {
  it("summarizes config without leaking secrets", () => {
    const config = loadConfig({ MODEL_API_KEY: "super-secret", RAG_ENABLED: "false" });
    const summary = describeRuntime(config);
    expect(summary.model).toBe("anthropic/claude-sonnet-4-6");
    expect(summary.rag).toBe("disabled");
    expect(JSON.stringify(summary)).not.toContain("super-secret");
  });
});
