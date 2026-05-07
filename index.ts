import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin } from "./src/channel.js";
import { setRocketChatRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "rocketchat",
  name: "Rocket.Chat",
  description: "Rocket.Chat channel plugin",
  plugin: rocketchatPlugin,
  setRuntime: setRocketChatRuntime,
});
