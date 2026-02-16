import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { rocketchatPlugin } from "./src/channel.js";
import { setRocketChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "rocketchat",
  name: "Rocket.Chat",
  description: "Rocket.Chat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setRocketChatRuntime(api.runtime);
    api.registerChannel({ plugin: rocketchatPlugin });
  },
};

export default plugin;
