import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LABEL = "com.myassistant.agent";

export interface PlistOptions {
  projectRoot: string;
  nodePath: string;
  distPath: string;
  logDir: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderPlist(options: PlistOptions): string {
  const args = [options.nodePath, options.distPath, "--daemon"]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(options.logDir, "daemon.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(options.logDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (packageJson.name === "myassistant") {
          return current;
        }
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the myassistant project root.");
    }
    current = parent;
  }
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function launchctl(args: string[], ignoreFailure = false): void {
  try {
    execFileSync("launchctl", args, { stdio: "inherit" });
  } catch (error) {
    if (!ignoreFailure) {
      throw error;
    }
  }
}

export function installLaunchd(): void {
  const projectRoot = findProjectRoot(import.meta.dirname);
  const distPath = join(projectRoot, "dist", "assistant.js");
  if (!existsSync(distPath)) {
    throw new Error(`Built entry not found at ${distPath}. Run "npm run build" first.`);
  }

  const logDir = join(projectRoot, "data", "logs");
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  mkdirSync(launchAgents, { recursive: true });

  const plist = plistPath();
  const contents = renderPlist({
    projectRoot,
    nodePath: process.execPath,
    distPath,
    logDir,
  });
  writeFileSync(plist, contents, { mode: 0o644 });

  launchctl(["bootout", domain(), plist], true);
  launchctl(["bootstrap", domain(), plist]);
  launchctl(["kickstart", "-k", `${domain()}/${LABEL}`], true);
  process.stdout.write(`Installed ${LABEL} at ${plist}\n`);
}

export function uninstallLaunchd(): void {
  const plist = plistPath();
  launchctl(["bootout", domain(), plist], true);
  if (existsSync(plist)) {
    rmSync(plist, { force: true });
  }
  process.stdout.write(`Uninstalled ${LABEL}\n`);
}

export function launchdStatus(): void {
  launchctl(["print", `${domain()}/${LABEL}`]);
}

function main(): void {
  const command = process.argv[2];
  if (command === "install") {
    installLaunchd();
    return;
  }
  if (command === "uninstall") {
    uninstallLaunchd();
    return;
  }
  if (command === "status") {
    launchdStatus();
    return;
  }
  if (command === "plist") {
    const projectRoot = findProjectRoot(import.meta.dirname);
    process.stdout.write(
      renderPlist({
        projectRoot,
        nodePath: process.execPath,
        distPath: join(projectRoot, "dist", "assistant.js"),
        logDir: join(projectRoot, "data", "logs"),
      }),
    );
    return;
  }
  process.stderr.write(
    "Usage: tsx apps/assistant/src/launchd.ts <install|uninstall|status|plist>\n",
  );
  process.exitCode = 1;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
