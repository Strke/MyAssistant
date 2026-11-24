import { loadConfigFromEnvFile } from "@myassistant/config";
import { createDwsGatewayClient } from "@myassistant/dingtalk-dws";

async function main(): Promise<void> {
  const config = loadConfigFromEnvFile();
  if (!config.dws.enabled) {
    process.stderr.write("DWS is disabled. Set DWS_ENABLED=true in .env.\n");
    process.exitCode = 1;
    return;
  }

  const client = createDwsGatewayClient({
    baseUrl: config.dws.gatewayUrl,
    token: config.dws.gatewayToken,
    timeoutMs: config.dws.requestTimeoutSeconds * 1_000,
  });

  const health = await client.health();
  const auth = await client.authStatus();
  process.stdout.write(
    `${JSON.stringify(
      {
        gateway: config.dws.gatewayUrl,
        health,
        auth,
        allowedGroups: config.dws.historyGroups,
      },
      null,
      2,
    )}\n`,
  );
  if (!auth.authenticated) {
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
