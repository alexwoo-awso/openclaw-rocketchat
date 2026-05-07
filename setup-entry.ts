import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { rocketchatPlugin } from "./src/channel.js";
export default defineSetupPluginEntry(rocketchatPlugin);
