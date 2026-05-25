import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");

test("manifest version matches package version", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"),
  ) as { version: string };
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
  ) as { version: string };

  assert.equal(manifest.version, packageJson.version);
});

test("manifest config schema is populated", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
  ) as {
    configSchema?: {
      properties?: Record<string, unknown>;
      "$defs"?: Record<string, unknown>;
      definitions?: Record<string, unknown>;
    };
  };

  assert.ok(manifest.configSchema, "manifest configSchema is missing");
  const propertyCount = Object.keys(manifest.configSchema?.properties ?? {}).length;
  const defCount =
    Object.keys(manifest.configSchema?.$defs ?? {}).length +
    Object.keys(manifest.configSchema?.definitions ?? {}).length;
  assert.ok(
    propertyCount > 0 || defCount > 0,
    "manifest configSchema should contain properties or definitions",
  );
});

test("manifest channelConfigs wraps the Rocket.Chat config schema", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
  ) as {
    configSchema?: unknown;
    channelConfigs?: {
      rocketchat?: {
        label?: string;
        description?: string;
        schema?: unknown;
      };
    };
  };

  const channelConfig = manifest.channelConfigs?.rocketchat;
  assert.ok(channelConfig, "manifest channelConfigs.rocketchat is missing");
  assert.equal(channelConfig.label, "Rocket.Chat");
  assert.equal(channelConfig.description, "Rocket.Chat channel plugin");
  assert.deepEqual(channelConfig.schema, manifest.configSchema);
});

test("manifest channel account schema supports login auth fields", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
  ) as {
    channelConfigs?: {
      rocketchat?: {
        schema?: {
          properties?: {
            accounts?: {
              additionalProperties?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      };
    };
  };

  const accountProperties =
    manifest.channelConfigs?.rocketchat?.schema?.properties?.accounts?.additionalProperties
      ?.properties;
  assert.ok(accountProperties?.username, "account schema username field is missing");
  assert.ok(accountProperties?.password, "account schema password field is missing");
});
