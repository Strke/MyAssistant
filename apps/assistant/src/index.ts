import { loadConfigFromEnvFile } from "@myassistant/config";
import { describeRuntime } from "@myassistant/core";

const config = loadConfigFromEnvFile();
const summary = describeRuntime(config);

process.stdout.write(`[assistant] config loaded: ${JSON.stringify(summary)}\n`);
process.stdout.write("[assistant] M0 scaffolding ready. Next milestone: M1 core conversation.\n");
