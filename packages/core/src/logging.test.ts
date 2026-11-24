import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logging";

function capture(): { lines: string[]; destination: DestinationStream } {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
}

describe("createLogger", () => {
  it("redacts secrets at any nesting level", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: "info", destination });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logger.info(
      {
        apiKey: "sk-live-123",
        nested: {
          clientSecret: "secret-value",
          headers: { authorization: "Bearer abc" },
          safe: "visible",
        },
        github_token: "ghp_123",
        list: [{ password: "hunter2" }],
        circular,
      },
      "startup",
    );

    const output = lines.join("");
    expect(output).toContain("visible");
    expect(output).toContain("startup");
    expect(output).not.toContain("sk-live-123");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("Bearer abc");
    expect(output).not.toContain("ghp_123");
    expect(output).not.toContain("hunter2");
    expect(output).toContain("[redacted]");
    expect(output).toContain("[circular]");
  });

  it("serializes errors without losing the message", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ level: "error", destination });
    logger.error({ error: new Error("boom") }, "failed");
    expect(lines.join("")).toContain("boom");
  });
});
