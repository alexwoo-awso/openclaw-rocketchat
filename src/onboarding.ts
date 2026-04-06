import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelSetupInput,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import {
  isRocketChatAccountConfigured,
  listRocketChatAccountIds,
  resolveDefaultRocketChatAccountId,
  resolveRocketChatAccount,
} from "./rocketchat/accounts.js";
import { normalizeRocketChatBaseUrl } from "./rocketchat/client.js";

const channel = "rocketchat" as const;
const AUTH_MODE_INPUT_KEY = "authMode" as keyof ChannelSetupInput;
const USERNAME_INPUT_KEY = "username" as keyof ChannelSetupInput;

type RocketChatAuthMode = "pat" | "login";

async function noteRocketChatSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Rocket.Chat Admin -> My Account -> Personal Access Tokens",
      "2) Create a token and copy both the Token and User ID",
      "2b) Or use username/password login if PAT is not available on your plan",
      "3) Use your server base URL (e.g., https://chat.example.com)",
      "Tip: the bot user must be a member of channels you want it to monitor.",
      "Docs: https://github.com/alexwoo-awso/openclaw-rocketchat/blob/main/README.md",
    ].join("\n"),
    "Rocket.Chat setup",
  );
}

async function promptAccountId(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  currentId?: string;
  defaultAccountId: string;
}): Promise<string> {
  const existingIds = listRocketChatAccountIds(params.cfg);
  const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
  const choice = await params.prompter.select({
    message: "Rocket.Chat account",
    options: [
      ...existingIds.map((id) => ({
        value: id,
        label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
      })),
      { value: "__new__", label: "Add a new account" },
    ],
    initialValue: initial,
  });

  if (choice !== "__new__") return normalizeAccountId(choice);

  const entered = await params.prompter.text({
    message: "New Rocket.Chat account id",
    validate: (value: string) => (value.trim() ? undefined : "Required"),
  });
  const normalized = normalizeAccountId(String(entered));
  if (String(entered).trim() !== normalized) {
    await params.prompter.note(
      `Normalized account id to "${normalized}".`,
      "Rocket.Chat account",
    );
  }
  return normalized;
}

function patchRocketChatAccount(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, string>,
  clearKeys: string[] = [],
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const next: Record<string, unknown> = {
      ...cfg.channels?.rocketchat,
      enabled: true,
      ...patch,
    };
    for (const key of clearKeys) {
      delete next[key];
    }
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        rocketchat: next,
      },
    };
  }

  const currentAccount = cfg.channels?.rocketchat?.accounts?.[accountId] as
    | Record<string, unknown>
    | undefined;
  const nextAccount: Record<string, unknown> = {
    ...currentAccount,
    enabled: currentAccount?.enabled ?? true,
    ...patch,
  };
  for (const key of clearKeys) {
    delete nextAccount[key];
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      rocketchat: {
        ...cfg.channels?.rocketchat,
        enabled: true,
        accounts: {
          ...cfg.channels?.rocketchat?.accounts,
          [accountId]: nextAccount,
        },
      },
    },
  };
}

function resolveRocketChatWizardAuthMode(cfg: OpenClawConfig, accountId: string): RocketChatAuthMode {
  const account = resolveRocketChatAccount({ cfg, accountId });
  if (account.usesLoginAuth) {
    return "login";
  }
  return "pat";
}

function resolveConfiguredStatus(cfg: OpenClawConfig): boolean {
  return listRocketChatAccountIds(cfg).some((accountId) =>
    isRocketChatAccountConfigured(resolveRocketChatAccount({ cfg, accountId })),
  );
}

export const rocketchatSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "Configured",
    unconfiguredLabel: "Needs setup",
    configuredHint: "Rocket.Chat account ready",
    unconfiguredHint: "Needs PAT or username/password plus base URL",
    configuredScore: 2,
    unconfiguredScore: 1,
    resolveConfigured: ({ cfg }) => resolveConfiguredStatus(cfg),
    resolveStatusLines: ({ configured }) => [
      `Rocket.Chat: ${configured ? "configured" : "needs credentials + base URL"}`,
    ],
    resolveSelectionHint: ({ configured }) => (configured ? "configured" : "needs setup"),
  },
  introNote: {
    title: "Rocket.Chat setup",
    lines: [
      "Use either a Personal Access Token (recommended) or username/password login.",
      "The bot user must be a member of channels you want it to monitor.",
      "Docs: https://github.com/alexwoo-awso/openclaw-rocketchat/blob/main/README.md",
    ],
  },
  resolveAccountIdForConfigure: async ({
    cfg,
    prompter,
    accountOverride,
    shouldPromptAccountIds,
    defaultAccountId,
  }) => {
    const override = accountOverride?.trim();
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        currentId: accountId,
        defaultAccountId,
      });
    }
    return accountId;
  },
  prepare: async ({ cfg, accountId, prompter }) => {
    const account = resolveRocketChatAccount({ cfg, accountId });
    if (!isRocketChatAccountConfigured(account)) {
      await noteRocketChatSetup(prompter);
    }
    const authMode = await prompter.select({
      message: "Rocket.Chat authentication method",
      options: [
        { value: "pat", label: "Personal Access Token" },
        { value: "login", label: "Username + password" },
      ],
      initialValue: resolveRocketChatWizardAuthMode(cfg, accountId),
    });
    return {
      credentialValues: {
        [AUTH_MODE_INPUT_KEY]: String(authMode),
      },
    };
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: "rocketchat",
      credentialLabel: "Personal access token",
      preferredEnvVar: "ROCKETCHAT_AUTH_TOKEN",
      envPrompt: "Use ROCKETCHAT_AUTH_TOKEN from environment?",
      keepPrompt: "Keep current Rocket.Chat auth token?",
      inputPrompt: "Enter Rocket.Chat auth token",
      inspect: ({ cfg, accountId }) => {
        const account = resolveRocketChatAccount({ cfg, accountId });
        const value = account.config.authToken?.trim();
        return {
          accountConfigured: isRocketChatAccountConfigured(account),
          hasConfiguredValue: Boolean(value),
          resolvedValue: value,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID ? process.env.ROCKETCHAT_AUTH_TOKEN?.trim() : undefined,
        };
      },
      shouldPrompt: ({ credentialValues }) => credentialValues[AUTH_MODE_INPUT_KEY] !== "login",
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchRocketChatAccount(cfg, accountId, { authToken: resolvedValue }, ["username", "password"]),
    },
    {
      inputKey: "userId",
      providerHint: "rocketchat",
      credentialLabel: "User ID",
      preferredEnvVar: "ROCKETCHAT_USER_ID",
      envPrompt: "Use ROCKETCHAT_USER_ID from environment?",
      keepPrompt: "Keep current Rocket.Chat user ID?",
      inputPrompt: "Enter Rocket.Chat user ID",
      inspect: ({ cfg, accountId }) => {
        const account = resolveRocketChatAccount({ cfg, accountId });
        const value = account.config.userId?.trim();
        return {
          accountConfigured: isRocketChatAccountConfigured(account),
          hasConfiguredValue: Boolean(value),
          resolvedValue: value,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID ? process.env.ROCKETCHAT_USER_ID?.trim() : undefined,
        };
      },
      shouldPrompt: ({ credentialValues }) => credentialValues[AUTH_MODE_INPUT_KEY] !== "login",
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchRocketChatAccount(cfg, accountId, { userId: resolvedValue }, ["username", "password"]),
    },
    {
      inputKey: USERNAME_INPUT_KEY,
      providerHint: "rocketchat",
      credentialLabel: "Username",
      preferredEnvVar: "ROCKETCHAT_USERNAME",
      envPrompt: "Use ROCKETCHAT_USERNAME from environment?",
      keepPrompt: "Keep current Rocket.Chat username?",
      inputPrompt: "Enter Rocket.Chat username",
      inspect: ({ cfg, accountId }) => {
        const account = resolveRocketChatAccount({ cfg, accountId });
        const value = account.config.username?.trim();
        return {
          accountConfigured: isRocketChatAccountConfigured(account),
          hasConfiguredValue: Boolean(value),
          resolvedValue: value,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID ? process.env.ROCKETCHAT_USERNAME?.trim() : undefined,
        };
      },
      shouldPrompt: ({ credentialValues }) => credentialValues[AUTH_MODE_INPUT_KEY] === "login",
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchRocketChatAccount(cfg, accountId, { username: resolvedValue }, ["authToken", "userId"]),
    },
    {
      inputKey: "password",
      providerHint: "rocketchat",
      credentialLabel: "Password",
      preferredEnvVar: "ROCKETCHAT_PASSWORD",
      envPrompt: "Use ROCKETCHAT_PASSWORD from environment?",
      keepPrompt: "Keep current Rocket.Chat password?",
      inputPrompt: "Enter Rocket.Chat password",
      inspect: ({ cfg, accountId }) => {
        const account = resolveRocketChatAccount({ cfg, accountId });
        const value = account.config.password?.trim();
        return {
          accountConfigured: isRocketChatAccountConfigured(account),
          hasConfiguredValue: Boolean(value),
          resolvedValue: value ? "********" : undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID ? process.env.ROCKETCHAT_PASSWORD?.trim() : undefined,
        };
      },
      shouldPrompt: ({ credentialValues }) => credentialValues[AUTH_MODE_INPUT_KEY] === "login",
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchRocketChatAccount(cfg, accountId, { password: resolvedValue }, ["authToken", "userId"]),
    },
  ],
  textInputs: [
    {
      inputKey: "httpUrl",
      message: "Enter Rocket.Chat base URL",
      placeholder: "https://chat.example.com",
      required: true,
      helpTitle: "Rocket.Chat base URL",
      helpLines: ["Use the base server URL, for example https://chat.example.com"],
      currentValue: ({ cfg, accountId }) =>
        resolveRocketChatAccount({ cfg, accountId }).baseUrl ?? undefined,
      validate: ({ value }) =>
        normalizeRocketChatBaseUrl(value) ? undefined : "Enter a valid base URL",
      normalizeValue: ({ value }) => normalizeRocketChatBaseUrl(value) ?? value.trim(),
      applySet: ({ cfg, accountId, value }) => patchRocketChatAccount(cfg, accountId, { baseUrl: value }),
    },
  ],
  finalize: async ({ cfg, accountId, credentialValues }) => {
    const authMode =
      credentialValues[AUTH_MODE_INPUT_KEY] === "login" ? "login" : ("pat" as RocketChatAuthMode);
    const nextCfg =
      authMode === "login"
        ? patchRocketChatAccount(cfg, accountId, {}, ["authToken", "userId"])
        : patchRocketChatAccount(cfg, accountId, {}, ["username", "password"]);
    return { cfg: nextCfg };
  },
  completionNote: {
    title: "Rocket.Chat configured",
    lines: [
      "Restart the gateway if the channel does not come online immediately.",
      "Use `openclaw status` or `openclaw channels logs --channel rocketchat` to verify connection state.",
    ],
  },
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      rocketchat: { ...cfg.channels?.rocketchat, enabled: false },
    },
  }),
};
