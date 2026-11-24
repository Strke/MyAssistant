import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(join(tmpdir(), "myassistant-smoke-"));
const socketPath = join(tempDir, "assistant.sock");
const masterKey = Buffer.alloc(32, 7).toString("base64");
const env = {
  ...process.env,
  AGENT_WORKSPACE: tempDir,
  RAG_ENABLED: "false",
  DINGTALK_ENABLED: "false",
  TASKS_ENABLED: "false",
  DAEMON_ENABLED: "false",
  DAEMON_SOCKET_PATH: socketPath,
  DAEMON_LOCAL_SESSION_DIR: join(tempDir, "local-sessions"),
  VAULT_PATH: join(tempDir, "vault.enc"),
  VAULT_MASTER_KEY: masterKey,
  LOG_LEVEL: "warn",
};

function runClient(...args: string[]): string {
  return execFileSync(
    process.execPath,
    [join(root, "dist", "client.js"), ...args, "--socket", socketPath],
    {
      env,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

async function waitForSocket(timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      statSync(socketPath);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error("Daemon did not create its control socket in time.");
}

let stderr = "";
const child = spawn(process.execPath, [join(root, "dist", "assistant.js"), "--daemon"], {
  cwd: tempDir,
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
  stderr += chunk;
});

try {
  await waitForSocket(20_000);
  const ping = JSON.parse(runClient("ping")) as { pong?: boolean };
  if (ping.pong !== true) {
    throw new Error(`Unexpected ping response: ${JSON.stringify(ping)}`);
  }

  const status = JSON.parse(runClient("status")) as {
    pid?: number;
    runtime?: { daemon?: string };
  };
  if (!status.pid || status.runtime?.daemon !== "enabled") {
    throw new Error(`Unexpected status response: ${JSON.stringify(status)}`);
  }

  const shutdown = JSON.parse(runClient("shutdown")) as { shuttingDown?: boolean };
  if (shutdown.shuttingDown !== true) {
    throw new Error(`Unexpected shutdown response: ${JSON.stringify(shutdown)}`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    if (child.exitCode !== null) {
      if (child.exitCode === 0) {
        resolvePromise();
      } else {
        reject(new Error(`Daemon exited with code ${child.exitCode}.`));
      }
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("Daemon did not exit after shutdown.")),
      10_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`Daemon exited with code ${code}.`));
      }
    });
  });
  process.stdout.write("daemon smoke test passed\n");
} catch (error) {
  child.kill("SIGKILL");
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (stderr) {
    process.stderr.write(`daemon stderr:\n${stderr}\n`);
  }
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
