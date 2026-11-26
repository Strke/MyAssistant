import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssetExecTool } from "./exec";
import { JsonAssetStore } from "./store";

const dirs: string[] = [];
const SECRET =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n";

type ExecutableTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
};

function setup(): {
  tool: ExecutableTool;
  auditPath: string;
  store: JsonAssetStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "myassistant-asset-exec-"));
  dirs.push(dir);
  const ssh = join(dir, "ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh
key=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-i" ]; then key="$2"; shift 2; continue; fi
  shift
done
if [ ! -f "$key" ]; then
  echo "missing key file" >&2
  exit 2
fi
echo "remote-ok"
echo "-----BEGIN OPENSSH PRIVATE KEY-----"
echo "REMOTE-KEY-MATERIAL"
echo "-----END OPENSSH PRIVATE KEY-----"
`,
  );
  chmodSync(ssh, 0o755);
  const auditPath = join(dir, "audit.log");
  const store = new JsonAssetStore(join(dir, "assets.json"));
  return {
    tool: createAssetExecTool(
      store,
      { get: async (name) => (name === "test_key" ? SECRET : undefined) },
      { enabled: true, timeoutMs: 5_000, maxOutputChars: 1_000, auditPath, sshBin: ssh },
    ) as unknown as ExecutableTool,
    auditPath,
    store,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("asset_exec", () => {
  it("runs an SSH command without returning the private key", async () => {
    const { tool, auditPath, store } = setup();
    await store.init();
    await store.save({
      id: "test-server",
      name: "Test",
      addresses: ["10.0.0.5"],
      access: [
        {
          id: "ssh",
          method: "ssh",
          username: "admin",
          secretName: "test_key",
          secretKind: "ssh_key",
          execEnabled: true,
        },
      ],
    });

    const result = await tool.execute("call", { id: "test-server", command: "echo hi" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("exitCode: 0");
    expect(text).toContain("remote-ok");
    expect(text).toContain("[redacted private key]");
    expect(text).not.toContain("SECRET-KEY-MATERIAL");
    expect(text).not.toContain("REMOTE-KEY-MATERIAL");

    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain(createHash("sha256").update("echo hi").digest("hex"));
    expect(audit).not.toContain("SECRET-KEY-MATERIAL");
  });

  it("refuses access entries without execEnabled", async () => {
    const { tool, store } = setup();
    await store.init();
    await store.save({
      id: "test-server",
      name: "Test",
      addresses: ["10.0.0.5"],
      access: [
        {
          id: "ssh",
          method: "ssh",
          username: "admin",
          secretName: "test_key",
          secretKind: "ssh_key",
        },
      ],
    });

    const result = await tool.execute("call", { id: "test-server", command: "echo hi" });
    expect(result.content[0]?.text).toContain("Execution is not enabled");
  });

  it("reports a missing vault secret without executing", async () => {
    const { tool, store } = setup();
    await store.init();
    await store.save({
      id: "test-server",
      name: "Test",
      addresses: ["10.0.0.5"],
      access: [
        {
          id: "ssh",
          method: "ssh",
          username: "admin",
          secretName: "missing_key",
          secretKind: "ssh_key",
          execEnabled: true,
        },
      ],
    });

    const result = await tool.execute("call", { id: "test-server", command: "echo hi" });
    expect(result.content[0]?.text).toContain("Vault secret not found");
  });
});
