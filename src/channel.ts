import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { RocketChatConfigSchema } from "./config-schema.js";
import { resolveRocketChatGroupRequireMention } from "./group-mentions.js";
import {
  listRocketChatAccountIds,
  resolveDefaultRocketChatAccountId,
  resolveRocketChatAccount,
  type ResolvedRocketChatAccount,
} from "./rocketchat/accounts.js";
import { normalizeRocketChatBaseUrl } from "./rocketchat/client.js";
import { monitorRocketChatProvider } from "./rocketchat/monitor.js";
import { probeRocketChat } from "./rocketchat/probe.js";
import { sendMessageRocketChat } from "./rocketchat/send.js";
import { looksLikeRocketChatTargetId, normalizeRocketChatMessagingTarget } from "./normalize.js";
import { rocketchatOnboardingAdapter } from "./onboarding.js";
import { getRocketChatRuntime } from "./runtime.js";

const meta = {
  id: "rocketchat",
  label: "Rocket.Chat",
  selectionLabel: "Rocket.Chat (plugin)",
  detailLabel: "Rocket.Chat Bot",
  docsPath: "/channels/rocketchat",
  docsLabel: "rocketchat",
  blurb: "self-hosted team chat; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 66,
  quickstartAllowFrom: true,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(rocketchat|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function formatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${username.toLowerCase()}` : "";
  }
  return trimmed.replace(/^(rocketchat|user):/i, "").toLowerCase();
}

export const rocketchatPlugin: ChannelPlugin<ResolvedRocketChatAccount> = {
  id: "rocketchat",
  meta: { ...meta },
  onboarding: rocketchatOnboardingAdapter,
  pairing: {
    idLabel: "rocketchatUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[rocketchat] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    threads: true,
    media: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.rocketchat"] },
  configSchema: buildChannelConfigSchema(RocketChatConfigSchema),
  config: {
    listAccountIds: (cfg) => listRocketChatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveRocketChatAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultRocketChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "rocketchat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "rocketchat",
        accountId,
        clearBaseFields: ["authToken", "userId", "baseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.authToken && account.userId && account.baseUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.authToken && account.userId && account.baseUrl),
      authTokenSource: account.authTokenSource,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveRocketChatAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.rocketchat?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.rocketchat.accounts.${resolvedAccountId}.`
        : "channels.rocketchat.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("rocketchat"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- Rocket.Chat channels: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.rocketchat.groupPolicy="allowlist" + channels.rocketchat.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveRocketChatGroupRequireMention,
  },
  messaging: {
    normalizeTarget: normalizeRocketChatMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeRocketChatTargetId,
      hint: "<roomId|user:ID|channel:ID|@username>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getRocketChatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Rocket.Chat requires --to <roomId|@username|user:ID|channel:ID>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendMessageRocketChat(to, text, {
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "rocketchat", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const result = await sendMessageRocketChat(to, text, {
        accountId: accountId ?? undefined,
        mediaUrl,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "rocketchat", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      authTokenSource: snapshot.authTokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.authToken?.trim();
      const uid = account.userId?.trim();
      const baseUrl = account.baseUrl?.trim();
      if (!token || !uid || !baseUrl) {
        return { ok: false, error: "authToken, userId, or baseUrl missing" };
      }
      return await probeRocketChat(baseUrl, token, uid, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.authToken && account.userId && account.baseUrl),
      authTokenSource: account.authTokenSource,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "rocketchat",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Rocket.Chat env vars can only be used for the default account.";
      }
      const token = input.authToken ?? input.token;
      const uid = input.userId;
      const baseUrl = input.httpUrl;
      if (!input.useEnv && (!token || !uid || !baseUrl)) {
        return "Rocket.Chat requires --auth-token, --user-id, and --http-url (or --use-env).";
      }
      if (baseUrl && !normalizeRocketChatBaseUrl(baseUrl)) {
        return "Rocket.Chat --http-url must include a valid base URL.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const token = input.authToken ?? input.token;
      const uid = input.userId;
      const baseUrl = input.httpUrl?.trim();
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "rocketchat",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "rocketchat",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            rocketchat: {
              ...next.channels?.rocketchat,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(token ? { authToken: token } : {}),
                    ...(uid ? { userId: uid } : {}),
                    ...(baseUrl ? { baseUrl } : {}),
                  }),
            },
          },
        };
      }
      return {
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
                enabled: true,
                ...(token ? { authToken: token } : {}),
                ...(uid ? { userId: uid } : {}),
                ...(baseUrl ? { baseUrl } : {}),
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        authTokenSource: account.authTokenSource,
      });
      ctx.log?.info(`[${account.accountId}] starting channel`);
      return monitorRocketChatProvider({
        authToken: account.authToken ?? undefined,
        userId: account.userId ?? undefined,
        baseUrl: account.baseUrl ?? undefined,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
