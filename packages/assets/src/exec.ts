import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Asset, AssetAccess, AssetStore } from "./types";

export interface SecretReader {
  get(name: string): Promise<string | undefined>;
}

export interface AssetExecOptions {
  enabled: boolean;
  timeoutMs: number;
  maxOutputChars: number;
  auditPath?: string;
  sshBin?: string;
  now?: () => number;
}

interface AssetExecParams {
  id: string;
  command: string;
  accessId?: string;
}

interface ExecResult {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

interface AuditEvent {
  at: number;
  assetId: string;
  accessId: string;
  method: string;
  host?: string;
  username?: string;
  secretName?: string;
  commandHash: string;
  commandLength: number;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

const MAX_COMMAND_CHARS = 8_000;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

function redactPrivateKeys(text: string): string {
  return text.replace(PRIVATE_KEY_PATTERN, "[redacted private key]");
}

function withTruncation(text: string, max: number, truncated: boolean): string {
  if (!truncated) {
    return text;
  }
  return `${text.slice(0, max)}\n… (output truncated)`;
}

function defaultPort(access: AssetAccess): number {
  return access.port ?? 22;
}

function findAccess(asset: Asset, accessId: string | undefined): AssetAccess | undefined {
  if (accessId) {
    return asset.access.find((entry) => entry.id === accessId);
  }
  return (
    asset.access.find((entry) => entry.method === "ssh" && entry.execEnabled === true) ??
    asset.access.find((entry) => entry.method === "ssh") ??
    asset.access[0]
  );
}

async function appendAudit(path: string | undefined, event: AuditEvent): Promise<void> {
  if (!path) {
    return;
  }
  try {
    await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "asset-exec-audit-error",
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

async function runSsh(
  asset: Asset,
  access: AssetAccess,
  key: string,
  command: string,
  options: AssetExecOptions,
): Promise<ExecResult> {
  const host = access.host ?? asset.addresses[0];
  if (!host) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
      error: "No host configured for this access entry.",
    };
  }
  if (!access.username) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
      error: "No username configured for this access entry.",
    };
  }

  const keyDir = await mkdtemp(join(tmpdir(), "myassistant-ssh-"));
  const keyPath = join(keyDir, "id_key");
  const startedAt = (options.now ?? Date.now)();
  await chmod(keyDir, 0o700);
  await writeFile(keyPath, key, { mode: 0o600 });
  await chmod(keyPath, 0o600);

  const port = defaultPort(access);
  const args = [
    "-i",
    keyPath,
    "-p",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-T",
    `${access.username}@${host}`,
    command,
  ];

  try {
    return await new Promise<ExecResult>((resolvePromise) => {
      const childEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME ?? homedir(),
        LANG: process.env.LANG ?? "en_US.UTF-8",
        TERM: "dumb",
      };
      if (process.env.LC_ALL) {
        childEnv.LC_ALL = process.env.LC_ALL;
      }
      const child = spawn(options.sshBin ?? "ssh", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const max = Math.max(100, options.maxOutputChars);

      const finish = (result: Omit<ExecResult, "durationMs">) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolvePromise({
          ...result,
          stdout: redactPrivateKeys(withTruncation(result.stdout, max, stdoutTruncated)),
          stderr: redactPrivateKeys(withTruncation(result.stderr, max, stderrTruncated)),
          durationMs: (options.now ?? Date.now)() - startedAt,
        });
      };

      timer = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGTERM");
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
          killTimer.unref?.();
        },
        Math.max(1_000, options.timeoutMs),
      );
      timer.unref?.();

      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, max - stdout.length);
        if (chunk.length > remaining) {
          stdoutTruncated = true;
        }
        stdout += chunk.toString().slice(0, remaining);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, max - stderr.length);
        if (chunk.length > remaining) {
          stderrTruncated = true;
        }
        stderr += chunk.toString().slice(0, remaining);
      });
      child.on("error", (error) => {
        finish({
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          error: error.message,
        });
      });
      child.on("close", (code, signal) => {
        finish({
          exitCode: code,
          signal,
          stdout,
          stderr,
          timedOut,
          error: timedOut ? `Command timed out after ${options.timeoutMs}ms.` : undefined,
        });
      });
    });
  } finally {
    await rm(keyDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function formatResult(result: ExecResult): string {
  const lines = [
    `exitCode: ${result.exitCode ?? "null"}`,
    `timedOut: ${result.timedOut}`,
    `durationMs: ${result.durationMs}`,
  ];
  if (result.signal) {
    lines.push(`signal: ${result.signal}`);
  }
  if (result.error) {
    lines.push(`error: ${result.error}`);
  }
  lines.push("", "stdout:", result.stdout || "(empty)", "", "stderr:", result.stderr || "(empty)");
  return lines.join("\n");
}

export function createAssetExecTool(
  store: AssetStore,
  secrets: SecretReader,
  options: AssetExecOptions,
): ToolDefinition {
  const tool = defineTool({
    name: "asset_exec",
    label: "Asset Exec",
    description:
      "Run a shell command on an allowlisted asset over SSH. The SSH private key is read from the encrypted vault inside the tool and never enters the model context. Only access entries with execEnabled=true and secretKind=ssh_key are allowed.",
    parameters: obj({
      id: str({ description: "Asset id, for example mac-mini." }),
      command: str({ description: "Shell command to run on the remote machine." }),
      accessId: opt(
        str({ description: "Access id. Defaults to the first executable SSH access." }),
      ),
    }),
    execute: async (_toolCallId, rawParams) => {
      if (!options.enabled) {
        return {
          content: [{ type: "text", text: "Asset execution is disabled." }],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      const params = rawParams as AssetExecParams;
      if (!params.command.trim()) {
        return {
          content: [{ type: "text", text: "command is required." }],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      if (params.command.length > MAX_COMMAND_CHARS) {
        return {
          content: [{ type: "text", text: "Command is too long." }],
          details: { allowed: false } as Record<string, unknown>,
        };
      }

      const asset = await store.get(params.id);
      if (!asset) {
        return {
          content: [{ type: "text", text: `Asset not found: ${params.id}` }],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      const access = findAccess(asset, params.accessId);
      if (!access) {
        return {
          content: [{ type: "text", text: `No matching access entry on ${asset.id}.` }],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      if (access.method !== "ssh") {
        return {
          content: [
            {
              type: "text",
              text: `Asset execution currently supports SSH only; ${access.id} uses ${access.method}.`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      if (access.execEnabled !== true) {
        return {
          content: [
            {
              type: "text",
              text: `Execution is not enabled for ${asset.id}/${access.id}. Set exec=true on the access entry.`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      if (!access.secretName) {
        return {
          content: [
            {
              type: "text",
              text: `No vault secret is linked to ${asset.id}/${access.id}.`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      if (access.secretKind !== "ssh_key") {
        return {
          content: [
            {
              type: "text",
              text: `Secret ${access.secretName} must have secretKind=ssh_key for SSH execution.`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      const host = access.host ?? asset.addresses[0];
      if (!host || !access.username) {
        return {
          content: [
            {
              type: "text",
              text: `Host and username are required for ${asset.id}/${access.id}.`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }

      let key: string | undefined;
      try {
        key = await secrets.get(access.secretName);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Vault read failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      if (!key) {
        return {
          content: [
            {
              type: "text",
              text: `Vault secret not found: ${access.secretName}. Store it with npm run vault -- set ${access.secretName} --file <path>.`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }
      if (!key.includes("PRIVATE KEY-----")) {
        return {
          content: [
            {
              type: "text",
              text: `Vault secret ${access.secretName} does not look like a private key.`,
            },
          ],
          details: { allowed: false } as Record<string, unknown>,
        };
      }

      const result = await runSsh(asset, access, key, params.command, options);
      const commandHash = createHash("sha256").update(params.command).digest("hex");
      await appendAudit(options.auditPath, {
        at: (options.now ?? Date.now)(),
        assetId: asset.id,
        accessId: access.id,
        method: access.method,
        host,
        username: access.username,
        secretName: access.secretName,
        commandHash,
        commandLength: params.command.length,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        error: result.error ? redactPrivateKeys(result.error) : undefined,
      });

      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: {
          allowed: true,
          assetId: asset.id,
          accessId: access.id,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        } as Record<string, unknown>,
      };
    },
  });
  return tool as unknown as ToolDefinition;
}
