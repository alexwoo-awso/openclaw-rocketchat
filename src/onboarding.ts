import type { ChannelOnboardingAdapter, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import {
  listRocketChatAccountIds,
  resolveDefaultRocketChatAccountId,
  resolveRocketChatAccount,
} from "./rocketchat/accounts.js";

const channel = "rocketchat" as const;

async function noteRocketChatSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Rocket.Chat Admin -> My Account -> Personal Access Tokens",
      "2) Create a token and copy both the Token and User ID",
      "3) Use your server base URL (e.g., https://chat.example.com)",
      "Tip: the bot user must be a member of channels you want it to monitor.",
      "Docs: https://docs.openclaw.ai/channels/rocketchat",
    ].join("\n"),
    "Rocket.Chat personal access token",
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
    validate: (value) => (value?.trim() ? undefined : "Required"),
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

export const rocketchatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listRocketChatAccountIds(cfg).some((accountId) => {
      const account = resolveRocketChatAccount({ cfg, accountId });
      return Boolean(account.authToken && account.userId && account.baseUrl);
    });
    return {
      channel,
      configured,
      statusLines: [`Rocket.Chat: ${configured ? "configured" : "needs token + userId + url"}`],
      selectionHint: configured ? "configured" : "needs setup",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides.rocketchat?.trim();
    const defaultAccountId = resolveDefaultRocketChatAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        currentId: accountId,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveRocketChatAccount({ cfg: next, accountId });
    const accountConfigured = Boolean(
      resolvedAccount.authToken && resolvedAccount.userId && resolvedAccount.baseUrl,
    );
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.ROCKETCHAT_AUTH_TOKEN?.trim()) &&
      Boolean(process.env.ROCKETCHAT_USER_ID?.trim()) &&
      Boolean(process.env.ROCKETCHAT_URL?.trim());
    const hasConfigValues =
      Boolean(resolvedAccount.config.authToken) ||
      Boolean(resolvedAccount.config.userId) ||
      Boolean(resolvedAccount.config.baseUrl);

    let authToken: string | null = null;
    let rcUserId: string | null = null;
    let baseUrl: string | null = null;

    if (!accountConfigured) {
      await noteRocketChatSetup(prompter);
    }

    if (canUseEnv && !hasConfigValues) {
      const keepEnv = await prompter.confirm({
        message: "ROCKETCHAT_AUTH_TOKEN + ROCKETCHAT_USER_ID + ROCKETCHAT_URL detected. Use env vars?",
        initialValue: true,
      });
      if (!keepEnv) {
        authToken = String(
          await prompter.text({
            message: "Enter Rocket.Chat auth token",
            validate: (v) => (v?.trim() ? undefined : "Required"),
          }),
        ).trim();
        rcUserId = String(
          await prompter.text({
            message: "Enter Rocket.Chat user ID",
            validate: (v) => (v?.trim() ? undefined : "Required"),
          }),
        ).trim();
        baseUrl = String(
          await prompter.text({
            message: "Enter Rocket.Chat base URL",
            validate: (v) => (v?.trim() ? undefined : "Required"),
          }),
        ).trim();
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            rocketchat: { ...next.channels?.rocketchat, enabled: true },
          },
        };
      }
    } else if (accountConfigured) {
      const keep = await prompter.confirm({
        message: "Rocket.Chat credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        authToken = String(
          await prompter.text({
            message: "Enter Rocket.Chat auth token",
            validate: (v) => (v?.trim() ? undefined : "Required"),
          }),
        ).trim();
        rcUserId = String(
          await prompter.text({
            message: "Enter Rocket.Chat user ID",
            validate: (v) => (v?.trim() ? undefined : "Required"),
          }),
        ).trim();
        baseUrl = String(
          await prompter.text({
            message: "Enter Rocket.Chat base URL",
            validate: (v) => (v?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      authToken = String(
        await prompter.text({
          message: "Enter Rocket.Chat auth token",
          validate: (v) => (v?.trim() ? undefined : "Required"),
        }),
      ).trim();
      rcUserId = String(
        await prompter.text({
          message: "Enter Rocket.Chat user ID",
          validate: (v) => (v?.trim() ? undefined : "Required"),
        }),
      ).trim();
      baseUrl = String(
        await prompter.text({
          message: "Enter Rocket.Chat base URL",
          validate: (v) => (v?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (authToken || rcUserId || baseUrl) {
      const creds = {
        ...(authToken ? { authToken } : {}),
        ...(rcUserId ? { userId: rcUserId } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      };
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            rocketchat: { ...next.channels?.rocketchat, enabled: true, ...creds },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            rocketchat: {
              ...next.channels?.rocketchat,
              enabled: true,
              accounts: {
                ...next.channels?.rocketchat?.accounts,
                [accountId]: {
                  ...next.channels?.rocketchat?.accounts?.[accountId],
                  enabled:
                    next.channels?.rocketchat?.accounts?.[accountId]?.enabled ?? true,
                  ...creds,
                },
              },
            },
          },
        };
      }
    }

    return { cfg: next, accountId };
  },
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      rocketchat: { ...cfg.channels?.rocketchat, enabled: false },
    },
  }),
};
