import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RocketChatConfigSchema } from "../src/config-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pluginRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(pluginRoot, "openclaw.plugin.json");
const packageJsonPath = path.join(pluginRoot, "package.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string };

const jsonSchema = z.toJSONSchema(RocketChatConfigSchema, { target: "draft-7" });

manifest.version = packageJson.version;
manifest.configSchema = jsonSchema;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`[rocketchat] synced manifest version and configSchema to ${manifestPath}`);
