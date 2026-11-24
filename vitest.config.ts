import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolvePath = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@myassistant/config": resolvePath("./packages/config/src/index.ts"),
      "@myassistant/core": resolvePath("./packages/core/src/index.ts"),
      "@myassistant/rag": resolvePath("./packages/rag/src/index.ts"),
      "@myassistant/vault": resolvePath("./packages/vault/src/index.ts"),
      "@myassistant/channel-dingtalk": resolvePath("./packages/channel-dingtalk/src/index.ts"),
      "@myassistant/dingtalk-dws": resolvePath("./packages/dingtalk-dws/src/index.ts"),
      "@myassistant/tasks": resolvePath("./packages/tasks/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
  },
});
