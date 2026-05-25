import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin } from "./src/channel.js";

type RocketChatSetupEntry = {
  plugin: ChannelPlugin;
};

const setupEntry: RocketChatSetupEntry = defineSetupPluginEntry(rocketchatPlugin);

export default setupEntry;
