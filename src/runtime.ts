import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const RUNTIME_KEY = "__openclaw_rocketchat_runtime__";

type RocketChatRuntimeGlobal = typeof globalThis & {
  [RUNTIME_KEY]?: PluginRuntime;
};

function runtimeGlobal(): RocketChatRuntimeGlobal {
  return globalThis as RocketChatRuntimeGlobal;
}

export function setRocketChatRuntime(next: PluginRuntime) {
  runtimeGlobal()[RUNTIME_KEY] = next;
}

export function getRocketChatRuntime(): PluginRuntime {
  const runtime = runtimeGlobal()[RUNTIME_KEY];
  if (!runtime) {
    throw new Error("Rocket.Chat runtime not initialized");
  }
  return runtime;
}
