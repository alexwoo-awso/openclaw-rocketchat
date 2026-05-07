import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const RUNTIME_KEY = "__openclaw_rocketchat_runtime__";

export function setRocketChatRuntime(next: PluginRuntime) {
  (globalThis as any)[RUNTIME_KEY] = next;
}

export function getRocketChatRuntime(): PluginRuntime {
  const runtime = (globalThis as any)[RUNTIME_KEY];
  if (!runtime) {
    throw new Error("Rocket.Chat runtime not initialized");
  }
  return runtime;
}
