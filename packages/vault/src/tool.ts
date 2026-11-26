import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { obj, str } from "@earendil-works/pi-schema";
import type { SecretStore } from "./types";

interface VaultGetParams {
  name: string;
}

export interface VaultToolOptions {
  protectedSecrets?: Iterable<string>;
  isProtected?: (name: string) => boolean | Promise<boolean>;
  protectedMessage?: string;
}

export function createVaultTools(
  vault: SecretStore,
  options: VaultToolOptions = {},
): ToolDefinition[] {
  const protectedSecrets = new Set(options.protectedSecrets ?? []);

  const vaultGet = defineTool({
    name: "vault_get",
    label: "Vault Get",
    description:
      "Read a secret from the local encrypted vault by name. Returns the plaintext value; every access is audited. SSH keys referenced by assets are protected and must be used through asset_exec instead.",
    parameters: obj({
      name: str({ description: "Secret name, for example github_token." }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as VaultGetParams;
      const protectedByList = protectedSecrets.has(params.name);
      const protectedByPolicy = options.isProtected
        ? await options.isProtected(params.name)
        : false;
      if (protectedByList || protectedByPolicy) {
        return {
          content: [
            {
              type: "text",
              text:
                options.protectedMessage ??
                `Secret "${params.name}" is protected and cannot be returned to the model. Use asset_exec for SSH access.`,
            },
          ],
          details: { found: false, protected: true } as Record<string, unknown>,
        };
      }
      const value = await vault.get(params.name);
      if (value === undefined) {
        return {
          content: [{ type: "text", text: `Secret not found: ${params.name}` }],
          details: { found: false } as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: value }],
        details: { found: true } as Record<string, unknown>,
      };
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
