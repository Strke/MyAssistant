import { JsonAssetStore } from "@myassistant/assets";
import type { AppConfig } from "@myassistant/config";

export async function openAssetStore(config: AppConfig): Promise<JsonAssetStore> {
  const store = new JsonAssetStore(config.assets.path);
  await store.init();
  return store;
}
