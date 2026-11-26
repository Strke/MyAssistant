import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Asset, AssetAccess, AssetStore } from "./types";

interface AssetListParams {
  query?: string;
  kind?: string;
  tag?: string;
  status?: "active" | "retired" | "all";
}

interface AssetGetParams {
  id: string;
}

interface AssetConnectionParams {
  id: string;
  accessId?: string;
}

const DEFAULT_PORTS: Record<string, number | undefined> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
  http: 80,
  https: 443,
  smb: 445,
};

function matchesQuery(asset: Asset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    asset.id,
    asset.name,
    asset.kind,
    asset.status,
    asset.os,
    asset.location,
    asset.notes,
    ...asset.addresses,
    ...asset.tags,
    ...asset.access.flatMap((access) => [
      access.id,
      access.method,
      access.host,
      access.username,
      access.secretName,
      access.notes,
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(needle));
}

function formatAssetLine(asset: Asset): string {
  const parts = [
    asset.id,
    asset.name,
    asset.kind,
    asset.status,
    asset.addresses.length > 0 ? asset.addresses.join(", ") : "no address",
  ];
  if (asset.tags.length > 0) {
    parts.push(`tags=${asset.tags.join(",")}`);
  }
  if (asset.access.length > 0) {
    parts.push(
      `access=${asset.access
        .map((access) => {
          const target = access.host ?? asset.addresses[0] ?? "?";
          const port = access.port ?? DEFAULT_PORTS[access.method];
          const user = access.username ? `${access.username}@` : "";
          const secret = access.secretName ? ` secret=${access.secretName}` : "";
          const exec = access.execEnabled ? " [exec]" : "";
          return `${access.id}:${access.method} ${user}${target}${port ? `:${port}` : ""}${secret}${exec}`;
        })
        .join("; ")}`,
    );
  }
  return `- ${parts.join(" | ")}`;
}

function accessTarget(asset: Asset, access: AssetAccess): string | undefined {
  return access.host ?? asset.addresses[0];
}

function defaultCommand(asset: Asset, access: AssetAccess): string | undefined {
  const host = accessTarget(asset, access);
  if (!host) {
    return undefined;
  }
  const port = access.port ?? DEFAULT_PORTS[access.method];
  const user = access.username ? `${access.username}@` : "";
  switch (access.method) {
    case "ssh":
      return `ssh${port ? ` -p ${port}` : ""} ${user}${host}`;
    case "rdp":
      return `rdp://${host}${port ? `:${port}` : ""}`;
    case "vnc":
      return `vnc://${host}${port ? `:${port}` : ""}`;
    case "http":
    case "https":
      return `${access.method}://${host}${port ? `:${port}` : ""}`;
    case "smb":
      return `smb://${host}${port ? `:${port}` : ""}`;
    case "serial":
      return `serial ${host}${port ? ` @${port}` : ""}`;
    default:
      return `${access.method} ${host}${port ? `:${port}` : ""}`;
  }
}

export function createAssetTools(store: AssetStore): ToolDefinition[] {
  const assetList = defineTool({
    name: "asset_list",
    label: "Asset List",
    description:
      "List machines, devices and services in the local asset inventory. Returns metadata and credential names only, never secret values.",
    parameters: obj({
      query: opt(str({ description: "Free-text filter over names, addresses, tags and notes." })),
      kind: opt(
        str({ description: "Filter by asset kind, for example server, vm, nas or router." }),
      ),
      tag: opt(str({ description: "Filter by tag." })),
      status: opt(str({ description: "active, retired, or all. Defaults to active." })),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as AssetListParams;
      const status = params.status ?? "active";
      const tag = params.tag?.trim().toLowerCase();
      const kind = params.kind?.trim().toLowerCase();
      const assets = (await store.list()).filter((asset) => {
        if (status !== "all" && asset.status !== status) {
          return false;
        }
        if (kind && asset.kind !== kind) {
          return false;
        }
        if (tag && !asset.tags.some((item) => item.toLowerCase() === tag)) {
          return false;
        }
        return params.query ? matchesQuery(asset, params.query) : true;
      });

      if (assets.length === 0) {
        return {
          content: [{ type: "text", text: "No matching assets." }],
          details: { count: 0 },
        };
      }
      return {
        content: [{ type: "text", text: assets.map(formatAssetLine).join("\n") }],
        details: { count: assets.length },
      };
    },
  });

  const assetGet = defineTool({
    name: "asset_get",
    label: "Asset Get",
    description:
      "Get full details for one asset, including connection endpoints and the names of vault secrets it references. Never returns secret values.",
    parameters: obj({
      id: str({ description: "Asset id, for example mac-mini." }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as AssetGetParams;
      const asset = await store.get(params.id);
      if (!asset) {
        return {
          content: [{ type: "text", text: `Asset not found: ${params.id}` }],
          details: { found: false } as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(asset, null, 2) }],
        details: { found: true, asset } as Record<string, unknown>,
      };
    },
  });

  const assetConnection = defineTool({
    name: "asset_connection",
    label: "Asset Connection",
    description:
      "Get connection details for an asset access method: host, port, username, command template and vault secret name. Never returns the secret value. Use vault_get only if the user explicitly asks to retrieve it.",
    parameters: obj({
      id: str({ description: "Asset id, for example mac-mini." }),
      accessId: opt(
        str({ description: "Access id. Defaults to the first access entry on the asset." }),
      ),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as AssetConnectionParams;
      const asset = await store.get(params.id);
      if (!asset) {
        return {
          content: [{ type: "text", text: `Asset not found: ${params.id}` }],
          details: { found: false } as Record<string, unknown>,
        };
      }
      if (asset.access.length === 0) {
        return {
          content: [{ type: "text", text: `Asset ${asset.id} has no access methods.` }],
          details: { found: true, access: false } as Record<string, unknown>,
        };
      }
      const access = params.accessId
        ? asset.access.find((entry) => entry.id === params.accessId)
        : asset.access[0];
      if (!access) {
        return {
          content: [
            {
              type: "text",
              text: `Access "${params.accessId}" not found on ${asset.id}. Available: ${asset.access
                .map((entry) => entry.id)
                .join(", ")}`,
            },
          ],
          details: { found: true, access: false } as Record<string, unknown>,
        };
      }
      const result: Record<string, unknown> = {
        assetId: asset.id,
        name: asset.name,
        accessId: access.id,
        method: access.method,
        host: accessTarget(asset, access),
        port: access.port ?? DEFAULT_PORTS[access.method],
        username: access.username,
        secretName: access.secretName,
        secretRef: access.secretName ? `vault://${access.secretName}` : undefined,
        secretKind: access.secretKind,
        execEnabled: access.execEnabled === true,
        command: access.command ?? defaultCommand(asset, access),
        notes: access.notes,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  return [
    assetList as unknown as ToolDefinition,
    assetGet as unknown as ToolDefinition,
    assetConnection as unknown as ToolDefinition,
  ];
}
