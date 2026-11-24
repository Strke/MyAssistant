import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfigFromEnvFile } from "@myassistant/config";

const config = loadConfigFromEnvFile();
const runtime = await ModelRuntime.create();

if (config.model.apiKey) {
  await runtime.setRuntimeApiKey(config.model.provider, config.model.apiKey);
}

const available = await runtime.getAvailable();
const configuredProvider = config.model.provider;
const configuredId = config.model.id;
const configuredModel = available.find(
  (model) => model.provider === configuredProvider && model.id === configuredId,
);

const byProvider = new Map<string, string[]>();
for (const model of available) {
  const ids = byProvider.get(model.provider) ?? [];
  ids.push(model.id);
  byProvider.set(model.provider, ids);
}

process.stdout.write(
  `configured: ${configuredProvider}/${configuredId} ` +
    `(auth: ${config.model.apiKey ? "MODEL_API_KEY" : "stored pi credential or provider env"})\n`,
);
process.stdout.write(
  `available: ${available.length} models across ${byProvider.size} provider(s)\n`,
);

if (available.length === 0) {
  process.stdout.write(
    "\nNo authenticated model providers found.\n" +
      "Run `npm run login`, then `/login` in the Pi UI and choose your provider and account.\n" +
      "Or set MODEL_PROVIDER / MODEL_ID / MODEL_API_KEY in .env.\n",
  );
  process.exitCode = 1;
} else {
  for (const [provider, ids] of [...byProvider.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const auth = runtime.isUsingSubscription(provider)
      ? "subscription/oauth"
      : runtime.isUsingOAuth(provider)
        ? "oauth"
        : "api-key";
    const preview = ids.slice(0, 6).join(", ");
    const suffix = ids.length > 6 ? `, … (${ids.length} total)` : "";
    process.stdout.write(`- ${provider} [${auth}]: ${preview}${suffix}\n`);
  }

  if (configuredModel) {
    process.stdout.write(
      `\n✅ configured model is available: ${configuredProvider}/${configuredId}\n`,
    );
  } else {
    const providerModels = byProvider.get(configuredProvider);
    process.stdout.write(
      `\n⚠️ configured model ${configuredProvider}/${configuredId} is not available.\n` +
        (providerModels
          ? `Available models for ${configuredProvider}: ${providerModels.slice(0, 10).join(", ")}${providerModels.length > 10 ? ", …" : ""}\n`
          : `Provider ${configuredProvider} has no usable authentication. Run npm run login.\n`) +
        "Update MODEL_PROVIDER / MODEL_ID in .env.\n",
    );
    process.exitCode = 1;
  }
}
