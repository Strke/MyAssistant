import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    assistant: "apps/assistant/src/index.ts",
    vault: "apps/assistant/src/cli.ts",
    client: "apps/assistant/src/client.ts",
    launchd: "apps/assistant/src/launchd.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  skipNodeModulesBundle: true,
  noExternal: [/^@myassistant\//],
  external: ["better-sqlite3", "sqlite-vec", "@napi-rs/keyring"],
  banner: { js: "#!/usr/bin/env node" },
});
