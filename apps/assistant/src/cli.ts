import { readFile } from "node:fs/promises";
import { stderr, stdin, stdout } from "node:process";
import { loadConfigFromEnvFile } from "@myassistant/config";
import { openVault } from "./vault-runtime";

function usage(): void {
  stdout.write(`Usage: npm run vault -- <command>

Commands:
  list                               List secret names
  get <name>                         Print a secret value
  set <name> [--description <text>] [--file <path>]
                                     Store or update a secret (value is prompted,
                                     or read from --file for multi-line keys)
  rm <name>                          Delete a secret
`);
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function readSecret(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        data += chunk;
      });
      stdin.on("end", () => resolvePromise(data.trim()));
      return;
    }

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolvePromise(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exitCode = 1;
    return;
  }

  const description = takeOption(rest, "--description");
  const filePath = takeOption(rest, "--file");
  const name = rest[0];

  const config = loadConfigFromEnvFile();
  const vault = openVault(config);

  try {
    switch (command) {
      case "list": {
        const items = await vault.list();
        if (items.length === 0) {
          stdout.write("Vault is empty.\n");
          break;
        }
        for (const item of items) {
          const updated = new Date(item.updatedAt).toISOString();
          const suffix = item.description ? ` - ${item.description}` : "";
          stdout.write(`${item.name}\t${updated}${suffix}\n`);
        }
        break;
      }
      case "get": {
        if (!name) {
          usage();
          process.exitCode = 1;
          break;
        }
        const value = await vault.get(name);
        if (value === undefined) {
          stderr.write(`Secret not found: ${name}\n`);
          process.exitCode = 1;
          break;
        }
        stdout.write(`${value}\n`);
        break;
      }
      case "set": {
        if (!name) {
          usage();
          process.exitCode = 1;
          break;
        }
        let value: string;
        if (filePath) {
          value = (await readFile(filePath, "utf8")).trim();
        } else {
          value = await readSecret(`Value for ${name}: `);
        }
        if (!value) {
          stderr.write("Empty value, nothing stored.\n");
          process.exitCode = 1;
          break;
        }
        await vault.set(name, value, description);
        stdout.write(`Stored secret "${name}".\n`);
        break;
      }
      case "rm":
      case "delete": {
        if (!name) {
          usage();
          process.exitCode = 1;
          break;
        }
        const removed = await vault.delete(name);
        stdout.write(removed ? `Deleted secret "${name}".\n` : `Secret not found: ${name}\n`);
        break;
      }
      default:
        usage();
        process.exitCode = 1;
    }
  } finally {
    await vault.close();
  }
}

await main();
