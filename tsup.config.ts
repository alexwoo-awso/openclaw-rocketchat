import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts", "setup-entry.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  external: [/^openclaw(?:\/.*)?$/, "ws"],
});
