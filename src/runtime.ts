import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setRocketChatRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getRocketChatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Rocket.Chat runtime not initialized");
  }
  return runtime;
}
