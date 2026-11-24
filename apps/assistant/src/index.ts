import { loadConfigFromEnvFile } from "@myassistant/config";
import { describeRuntime, runRepl } from "@myassistant/core";

const config = loadConfigFromEnvFile();

process.stdout.write(`[assistant] config: ${JSON.stringify(describeRuntime(config))}\n`);

await runRepl(config);
