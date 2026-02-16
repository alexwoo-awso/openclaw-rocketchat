import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { RocketChatConfigSchema } from "../src/config-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pluginRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(pluginRoot, "openclaw.plugin.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;

const jsonSchema = zodToJsonSchema(RocketChatConfigSchema, {
  name: "RocketChatConfig",
  target: "jsonSchema7",
  $refStrategy: "none",
});

manifest.configSchema = jsonSchema;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`[rocketchat] wrote configSchema to ${manifestPath}`);
