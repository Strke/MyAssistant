import { stderr, stdout } from "node:process";
import type {
  Asset,
  AssetAccessInput,
  AssetInput,
  AssetKind,
  AssetStatus,
  SecretKind,
} from "@myassistant/assets";
import { loadConfigFromEnvFile } from "@myassistant/config";
import { openAssetStore } from "./asset-runtime";
import { openVault } from "./vault-runtime";

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string[]>;
  json: boolean;
}

function usage(): void {
  stdout.write(`Usage: npm run assets -- <command> [options]

Commands:
  list [--json]                       List assets
  show <id> [--json]                  Show one asset
  add <id> [options]                  Create an asset
  update <id> [options]               Update an asset
  rm <id>                             Delete an asset
  doctor                              Check that referenced vault secrets exist

Options for add/update:
  --name <name>                       Display name (defaults to id for add)
  --kind <kind>                       server, vm, nas, router, switch, laptop,
                                      desktop, phone, tablet, container, cloud, other
  --status <status>                   active or retired
  --address <host>                    Repeatable. IP or hostname
  --tag <tag>                         Repeatable
  --os <os>
  --location <location>
  --notes <text>
  --access <spec>                     Repeatable. Example:
                                      ssh:label=tailscale,host=10.0.0.2,port=22,user=renze.lin,secret=macmini_ssh,secretKind=ssh_key
                                      Keys: label, host, port, user, secret, secretKind, command, notes
  --access-json <json>                Repeatable. JSON object for complex access entries

Secrets stay in the encrypted vault. Store them with:
  npm run vault -- set <secret-name> --description "SSH key for Mac mini"
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      const values = options.get(key) ?? [];
      values.push(value);
      options.set(key, values);
      index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, options, json };
}

function one(args: ParsedArgs, key: string): string | undefined {
  return args.options.get(key)?.[0];
}

function all(args: ParsedArgs, key: string): string[] {
  return args.options.get(key) ?? [];
}

function parseIntOption(value: string | undefined, name: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

function parseAccessSpec(spec: string): AssetAccessInput {
  const colon = spec.indexOf(":");
  if (colon <= 0) {
    throw new Error(`Invalid access spec "${spec}". Expected method:key=value,...`);
  }
  const method = spec.slice(0, colon).trim();
  const attributes: Record<string, string> = {};
  for (const part of spec.slice(colon + 1).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      throw new Error(`Invalid access attribute "${trimmed}" in "${spec}".`);
    }
    attributes[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim();
  }
  return {
    method: method as AssetAccessInput["method"],
    id: attributes.label ?? attributes.id,
    host: attributes.host,
    port: parseIntOption(attributes.port, "access port"),
    username: attributes.user ?? attributes.username,
    secretName: attributes.secret ?? attributes.secretName,
    secretKind: (attributes.secretKind ?? attributes.kind) as SecretKind | undefined,
    command: attributes.command ?? attributes.cmd,
    notes: attributes.notes,
  };
}

function parseAccessArgs(args: ParsedArgs): AssetAccessInput[] | undefined {
  const specs = all(args, "access").map(parseAccessSpec);
  const jsonEntries = all(args, "access-json").map((value, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`--access-json entry ${index + 1} is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`--access-json entry ${index + 1} must be a JSON object.`);
    }
    return parsed as AssetAccessInput;
  });
  const access = [...specs, ...jsonEntries];
  return access.length > 0 ? access : undefined;
}

function buildInput(id: string, args: ParsedArgs, existing: Asset | undefined): AssetInput {
  const name = one(args, "name") ?? existing?.name ?? id;
  const kind = (one(args, "kind") ?? existing?.kind) as AssetKind | undefined;
  const status = (one(args, "status") ?? existing?.status) as AssetStatus | undefined;
  const addresses = all(args, "address");
  const tags = all(args, "tag");
  const access = parseAccessArgs(args);
  return {
    id,
    name,
    kind,
    status,
    addresses: addresses.length > 0 ? addresses : existing?.addresses,
    tags: tags.length > 0 ? tags : existing?.tags,
    os: one(args, "os") ?? existing?.os,
    location: one(args, "location") ?? existing?.location,
    notes: one(args, "notes") ?? existing?.notes,
    access: access ?? existing?.access,
  };
}

function formatAsset(asset: Asset): string {
  const lines = [
    asset.id,
    `  name: ${asset.name}`,
    `  kind: ${asset.kind}`,
    `  status: ${asset.status}`,
    `  addresses: ${asset.addresses.length > 0 ? asset.addresses.join(", ") : "-"}`,
    `  tags: ${asset.tags.length > 0 ? asset.tags.join(", ") : "-"}`,
  ];
  if (asset.os) {
    lines.push(`  os: ${asset.os}`);
  }
  if (asset.location) {
    lines.push(`  location: ${asset.location}`);
  }
  if (asset.notes) {
    lines.push(`  notes: ${asset.notes}`);
  }
  if (asset.access.length === 0) {
    lines.push("  access: -");
  } else {
    lines.push("  access:");
    for (const access of asset.access) {
      const target = access.host ?? asset.addresses[0] ?? "?";
      const port = access.port ? `:${access.port}` : "";
      const user = access.username ? `${access.username}@` : "";
      const secret = access.secretName
        ? ` secret=${access.secretName}${access.secretKind ? ` (${access.secretKind})` : ""}`
        : "";
      lines.push(`    - ${access.id}: ${access.method} ${user}${target}${port}${secret}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatList(assets: Asset[]): string {
  if (assets.length === 0) {
    return "No assets.\n";
  }
  const lines = ["id\tname\tkind\tstatus\taddresses\ttags"];
  for (const asset of assets) {
    lines.push(
      [
        asset.id,
        asset.name,
        asset.kind,
        asset.status,
        asset.addresses.join(",") || "-",
        asset.tags.join(",") || "-",
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const [command, ...rest] = rawArgs;
  if (!command || command === "help" || command === "--help") {
    usage();
    if (!command) {
      process.exitCode = 1;
    }
    return;
  }

  const args = parseArgs(rest);
  const config = loadConfigFromEnvFile();
  const store = await openAssetStore(config);

  switch (command) {
    case "list": {
      const assets = await store.list();
      stdout.write(args.json ? `${JSON.stringify(assets, null, 2)}\n` : formatList(assets));
      break;
    }
    case "show": {
      const id = args.positionals[0];
      if (!id) {
        throw new Error("show requires an asset id.");
      }
      const asset = await store.get(id);
      if (!asset) {
        throw new Error(`Asset not found: ${id}`);
      }
      stdout.write(args.json ? `${JSON.stringify(asset, null, 2)}\n` : formatAsset(asset));
      break;
    }
    case "add": {
      const id = args.positionals[0];
      if (!id) {
        throw new Error("add requires an asset id.");
      }
      const existing = await store.get(id);
      if (existing) {
        throw new Error(`Asset already exists: ${id}. Use update.`);
      }
      const asset = await store.save(buildInput(id, args, undefined));
      stdout.write(
        args.json
          ? `${JSON.stringify(asset, null, 2)}\n`
          : `Created asset "${asset.id}".\n${formatAsset(asset)}`,
      );
      break;
    }
    case "update": {
      const id = args.positionals[0];
      if (!id) {
        throw new Error("update requires an asset id.");
      }
      const existing = await store.get(id);
      if (!existing) {
        throw new Error(`Asset not found: ${id}`);
      }
      const asset = await store.save(buildInput(id, args, existing));
      stdout.write(
        args.json
          ? `${JSON.stringify(asset, null, 2)}\n`
          : `Updated asset "${asset.id}".\n${formatAsset(asset)}`,
      );
      break;
    }
    case "rm":
    case "delete": {
      const id = args.positionals[0];
      if (!id) {
        throw new Error("rm requires an asset id.");
      }
      const removed = await store.delete(id);
      stdout.write(
        args.json
          ? `${JSON.stringify({ id, removed }, null, 2)}\n`
          : removed
            ? `Deleted asset "${id}".\n`
            : `Asset not found: ${id}\n`,
      );
      break;
    }
    case "doctor": {
      const assets = await store.list();
      const vault = openVault(config);
      try {
        const secrets = new Set((await vault.list()).map((item) => item.name));
        const missing: string[] = [];
        for (const asset of assets) {
          for (const access of asset.access) {
            if (access.secretName && !secrets.has(access.secretName)) {
              missing.push(`${asset.id}/${access.id} -> ${access.secretName}`);
            }
          }
        }
        if (missing.length === 0) {
          stdout.write(
            `Checked ${assets.length} asset(s) against ${secrets.size} vault secret(s); all references exist.\n`,
          );
        } else {
          stdout.write(
            `Missing vault secrets:\n${missing.map((item) => `- ${item}`).join("\n")}\n`,
          );
          process.exitCode = 1;
        }
      } finally {
        await vault.close();
      }
      break;
    }
    default:
      usage();
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
