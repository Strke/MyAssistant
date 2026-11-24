import { loadConfigFromEnvFile } from "@myassistant/config";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      response?: { status?: unknown; data?: unknown };
    };
    const message = typeof record.message === "string" ? record.message : String(error);
    if (record.response) {
      const status = record.response.status;
      const data =
        typeof record.response.data === "string"
          ? record.response.data
          : JSON.stringify(record.response.data);
      return `${message} (HTTP ${String(status)}: ${data?.slice(0, 300) ?? ""})`;
    }
    return message;
  }
  return String(error);
}

const config = loadConfigFromEnvFile();
const { clientId, clientSecret, robotCode } = config.dingtalk;

if (!clientId || !clientSecret) {
  process.stderr.write(
    "DingTalk credentials are missing. Set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET in .env.\n",
  );
  process.exitCode = 1;
} else {
  const masked = `${clientId.slice(0, 4)}…${clientId.slice(-3)}`;
  const client = new DWClient({
    clientId,
    clientSecret,
    debug: false,
  });
  client.registerCallbackListener(TOPIC_ROBOT, () => undefined);

  try {
    process.stdout.write(`[dingtalk] checking credentials (${masked}) and Stream gateway…\n`);
    await client.getEndpoint();
    process.stdout.write("[dingtalk] gateway accepted the app and robot subscription\n");

    process.stdout.write("[dingtalk] opening Stream WebSocket…\n");
    await client.connect();
    const deadline = Date.now() + 15_000;
    while (!client.connected) {
      if (Date.now() >= deadline) {
        throw new Error(
          "WebSocket did not connect within 15 seconds. Check network access and the app's Stream robot configuration.",
        );
      }
      await delay(100);
    }
    process.stdout.write(
      `[dingtalk] ✅ Stream connected (robot: ${robotCode ?? "default"}). Text messages can now arrive.\n`,
    );
  } catch (error) {
    process.stderr.write(`[dingtalk] ❌ connection failed: ${describeError(error)}\n`);
    process.exitCode = 1;
  } finally {
    client.disconnect();
  }
}
