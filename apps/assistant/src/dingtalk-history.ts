import { loadConfigFromEnvFile } from "@myassistant/config";
import {
  formatDwsTime,
  type HistoryImportInput,
  importDingTalkHistory,
  parseDwsTime,
} from "./dingtalk-history-lib";

interface ParsedArgs {
  input: HistoryImportInput;
  json: boolean;
}

function usage(): void {
  process.stdout.write(`Usage: npm run dingtalk:history -- <target> [options]

Targets (exactly one):
  --group <openConversationId>     Import a group
  --user <userId>                  Import a direct conversation by userId
  --open-dingtalk-id <id>          Import a direct conversation by openDingTalkId

Options:
  --since <time>                   Start time (default: now - DWS_HISTORY_BACKFILL_DAYS)
  --until <time>                   End time (default: now)
  --max-items <n>                  Maximum messages to fetch
  --json                           Print JSON summary
`);
}

function parseArgs(args: string[]): ParsedArgs {
  const input: HistoryImportInput = {};
  let json = false;
  const take = (index: number, name: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--group":
        input.groupId = take(index, arg);
        index += 1;
        break;
      case "--user":
        input.userId = take(index, arg);
        index += 1;
        break;
      case "--open-dingtalk-id":
        input.openDingTalkId = take(index, arg);
        index += 1;
        break;
      case "--since":
        input.since = take(index, arg);
        index += 1;
        break;
      case "--until":
        input.until = take(index, arg);
        index += 1;
        break;
      case "--max-items": {
        const value = Number(take(index, arg));
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error("--max-items must be a positive integer.");
        }
        input.maxItems = value;
        index += 1;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const targets = [input.groupId, input.userId, input.openDingTalkId].filter(Boolean);
  if (targets.length !== 1) {
    throw new Error("Provide exactly one of --group, --user or --open-dingtalk-id.");
  }
  return { input, json };
}

async function main(): Promise<void> {
  const { input, json } = parseArgs(process.argv.slice(2));
  const config = loadConfigFromEnvFile();
  const now = Date.now();
  const since = input.since
    ? parseDwsTime(input.since, Number.NaN)
    : now - config.dws.historyBackfillDays * 86_400_000;
  const until = input.until ? parseDwsTime(input.until, Number.NaN) : now;
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
    throw new Error("Invalid --since/--until range.");
  }

  const summary = await importDingTalkHistory(config, {
    ...input,
    since: formatDwsTime(since),
    until: formatDwsTime(until),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[dingtalk:history] target=${summary.target}\n` +
        `  range: ${summary.since} -> ${summary.until}\n` +
        `  fetched=${summary.fetched} imported=${summary.imported} duplicates=${summary.duplicates} skipped=${summary.skipped} failed=${summary.failed}\n` +
        `  complete=${summary.complete} hasMore=${summary.hasMore}` +
        (summary.stopReason ? ` stopReason=${summary.stopReason}` : "") +
        "\n",
    );
    if (summary.failures.length > 0) {
      process.stdout.write(`  failures: ${JSON.stringify(summary.failures)}\n`);
    }
    for (const error of summary.errors) {
      process.stdout.write(`  error: ${error}\n`);
    }
    if (!summary.complete) {
      process.stdout.write(
        "  warning: DWS reported an incomplete result; do not treat this range as fully imported.\n",
      );
    }
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
