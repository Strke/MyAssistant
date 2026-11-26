import { describe, expect, it } from "vitest";
import { createVaultTools } from "./tool";
import type { SecretStore } from "./types";

type ExecutableTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
};

function setup(): { tools: ExecutableTool[]; gets: string[] } {
  const gets: string[] = [];
  const vault: SecretStore = {
    has: async () => true,
    get: async (name) => {
      gets.push(name);
      return name === "token" ? "token-value" : "ssh-private-key";
    },
    set: async () => undefined,
    delete: async () => true,
    list: async () => [],
  };
  return {
    tools: createVaultTools(vault, {
      protectedSecrets: ["macmini_ssh"],
    }) as unknown as ExecutableTool[],
    gets,
  };
}

describe("vault tools", () => {
  it("protects SSH keys referenced by assets", async () => {
    const { tools, gets } = setup();
    const get = tools.find((tool) => tool.name === "vault_get");
    const result = await get?.execute("call", { name: "macmini_ssh" });
    expect(result?.content[0]?.text).toContain("protected");
    expect(gets).toEqual([]);
  });

  it("still returns non-protected secrets", async () => {
    const { tools } = setup();
    const get = tools.find((tool) => tool.name === "vault_get");
    const result = await get?.execute("call", { name: "token" });
    expect(result?.content[0]?.text).toBe("token-value");
  });

  it("supports a dynamic protected-secret policy", async () => {
    const gets: string[] = [];
    const vault: SecretStore = {
      has: async () => true,
      get: async (name) => {
        gets.push(name);
        return "ssh-private-key";
      },
      set: async () => undefined,
      delete: async () => true,
      list: async () => [],
    };
    const tools = createVaultTools(vault, {
      isProtected: (name) => name === "dynamic_ssh",
    }) as unknown as ExecutableTool[];
    const get = tools.find((tool) => tool.name === "vault_get");
    const result = await get?.execute("call", { name: "dynamic_ssh" });
    expect(result?.content[0]?.text).toContain("protected");
    expect(gets).toEqual([]);
  });
});
