import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { obj, str } from "@earendil-works/pi-schema";
import type { SecretStore } from "./types";

interface VaultGetParams {
  name: string;
}

export function createVaultTools(vault: SecretStore): ToolDefinition[] {
  const vaultGet = defineTool({
    name: "vault_get",
    label: "Vault Get",
    description:
      "Read a secret from the local encrypted vault by name. Returns the plaintext value; every access is audited.",
    parameters: obj({
      name: str({ description: "Secret name, for example github_token." }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as VaultGetParams;
      const value = await vault.get(params.name);
      if (value === undefined) {
        return {
          content: [{ type: "text", text: `Secret not found: ${params.name}` }],
          details: { found: false },
        };
      }
      return { content: [{ type: "text", text: value }], details: { found: true } };
    },
  });

  const vaultList = defineTool({
    name: "vault_list",
    label: "Vault List",
    description: "List secret names stored in the local encrypted vault. Does not reveal values.",
    parameters: obj({}),
    execute: async () => {
      const items = await vault.list();
      if (items.length === 0) {
        return {
          content: [{ type: "text", text: "The vault is empty." }],
          details: { count: 0 },
        };
      }
      const text = items
        .map((item) =>
          item.description ? `- ${item.name}: ${item.description}` : `- ${item.name}`,
        )
        .join("\n");
      return { content: [{ type: "text", text }], details: { count: items.length } };
    },
  });

  return [vaultGet as unknown as ToolDefinition, vaultList as unknown as ToolDefinition];
}
