import type { ChannelPlugin, OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin } from "./src/channel.js";
import { setRocketChatRuntime } from "./src/runtime.js";

type RocketChatPluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: unknown;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: ChannelPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

const plugin: RocketChatPluginEntry = defineChannelPluginEntry({
  id: "rocketchat",
  name: "Rocket.Chat",
  description: "Rocket.Chat channel plugin",
  plugin: rocketchatPlugin,
  setRuntime: setRocketChatRuntime,
});

export default plugin;
