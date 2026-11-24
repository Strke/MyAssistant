import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfigFromEnvFile } from "@myassistant/config";
import { formatDwsTime, importDingTalkHistory } from "./dingtalk-history-lib";

interface GroupState {
  lastSyncedAt: number;
}

interface SyncState {
  version: 1;
  groups: Record<string, GroupState>;
}

function statePath(): string {
  return process.env.DWS_SYNC_STATE_PATH ?? resolve("data", "dingtalk-sync.json");
}

async function loadState(path: string): Promise<SyncState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    if (parsed.version !== 1 || !parsed.groups || typeof parsed.groups !== "object") {
      throw new Error(`Unsupported sync state format: ${path}`);
    }
    return { version: 1, groups: parsed.groups as Record<string, GroupState> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, groups: {} };
    }
    throw error;
  }
}

async function saveState(path: string, state: SyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function main(): Promise<void> {
  const config = loadConfigFromEnvFile();
  if (!config.dws.enabled) {
    throw new Error("DWS is disabled. Set DWS_ENABLED=true in .env.");
  }
  const groups = config.dws.historyGroups;
  if (groups.length === 0) {
    throw new Error("DWS_HISTORY_GROUPS is empty; add the group ids you want to import.");
  }

  const path = resolve(statePath());
  const state = await loadState(path);
  const now = Date.now();
  let failures = 0;

  for (const group of groups) {
    const previous = state.groups[group]?.lastSyncedAt;
    const since = previous
      ? Math.max(0, previous - config.dws.historyOverlapMinutes * 60_000)
      : now - config.dws.historyBackfillDays * 86_400_000;
    const until = now;

    try {
      const summary = await importDingTalkHistory(config, {
        groupId: group,
        since: formatDwsTime(since),
        until: formatDwsTime(until),
      });
      if (summary.complete) {
        state.groups[group] = { lastSyncedAt: until };
      } else {
        const latest = summary.latestCreatedAt;
        if (latest !== undefined) {
          state.groups[group] = { lastSyncedAt: latest };
        }
        failures += 1;
      }
      await saveState(path, state);
      process.stdout.write(
        `[dingtalk:sync] ${group}: fetched=${summary.fetched} imported=${summary.imported} ` +
          `duplicates=${summary.duplicates} complete=${summary.complete} ` +
          `last=${new Date(state.groups[group]?.lastSyncedAt ?? since).toISOString()}\n`,
      );
      if (summary.failures.length > 0) {
        process.stdout.write(`  failures: ${JSON.stringify(summary.failures)}\n`);
      }
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[dingtalk:sync] ${group}: ${message}\n`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
