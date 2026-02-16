import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { RocketChatAccountConfig, RocketChatChatMode } from "../types.js";
import { normalizeRocketChatBaseUrl } from "./client.js";

export type RocketChatTokenSource = "env" | "config" | "none";
export type RocketChatBaseUrlSource = "env" | "config" | "none";

export type ResolvedRocketChatAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  authToken?: string;
  userId?: string;
  username?: string;
  password?: string;
  baseUrl?: string;
  authTokenSource: RocketChatTokenSource;
  userIdSource: RocketChatTokenSource;
  baseUrlSource: RocketChatBaseUrlSource;
  /** True if auth is via username/password login (not PAT). */
  usesLoginAuth: boolean;
  config: RocketChatAccountConfig;
  chatmode?: RocketChatChatMode;
  oncharPrefixes?: string[];
  requireMention?: boolean;
  textChunkLimit?: number;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: RocketChatAccountConfig["blockStreamingCoalesce"];
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.rocketchat?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listRocketChatAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultRocketChatAccountId(cfg: OpenClawConfig): string {
  const ids = listRocketChatAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): RocketChatAccountConfig | undefined {
  const accounts = cfg.channels?.rocketchat?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as RocketChatAccountConfig | undefined;
}

function mergeRocketChatAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): RocketChatAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.rocketchat ??
    {}) as RocketChatAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveRocketChatRequireMention(config: RocketChatAccountConfig): boolean | undefined {
  if (config.chatmode === "oncall") {
    return true;
  }
  if (config.chatmode === "onmessage") {
    return false;
  }
  if (config.chatmode === "onchar") {
    return true;
  }
  return config.requireMention;
}

export function resolveRocketChatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedRocketChatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.rocketchat?.enabled !== false;
  const merged = mergeRocketChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? process.env.ROCKETCHAT_AUTH_TOKEN?.trim() : undefined;
  const envUserId = allowEnv ? process.env.ROCKETCHAT_USER_ID?.trim() : undefined;
  const envUrl = allowEnv ? process.env.ROCKETCHAT_URL?.trim() : undefined;
  const envUsername = allowEnv ? process.env.ROCKETCHAT_USERNAME?.trim() : undefined;
  const envPassword = allowEnv ? process.env.ROCKETCHAT_PASSWORD?.trim() : undefined;
  const configToken = merged.authToken?.trim();
  const configUserId = merged.userId?.trim();
  const configUrl = merged.baseUrl?.trim();
  const configUsername = merged.username?.trim();
  const configPassword = merged.password?.trim();
  const authToken = configToken || envToken;
  const userId = configUserId || envUserId;
  const username = configUsername || envUsername;
  const password = configPassword || envPassword;
  const baseUrl = normalizeRocketChatBaseUrl(configUrl || envUrl);
  const requireMention = resolveRocketChatRequireMention(merged);
  const usesLoginAuth = !authToken && !userId && Boolean(username) && Boolean(password);

  const authTokenSource: RocketChatTokenSource = configToken ? "config" : envToken ? "env" : "none";
  const userIdSource: RocketChatTokenSource = configUserId ? "config" : envUserId ? "env" : "none";
  const baseUrlSource: RocketChatBaseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    authToken,
    userId,
    username,
    password,
    baseUrl,
    authTokenSource,
    userIdSource,
    baseUrlSource,
    usesLoginAuth,
    config: merged,
    chatmode: merged.chatmode,
    oncharPrefixes: merged.oncharPrefixes,
    requireMention,
    textChunkLimit: merged.textChunkLimit,
    blockStreaming: merged.blockStreaming,
    blockStreamingCoalesce: merged.blockStreamingCoalesce,
  };
}

export function listEnabledRocketChatAccounts(cfg: OpenClawConfig): ResolvedRocketChatAccount[] {
  return listRocketChatAccountIds(cfg)
    .map((accountId) => resolveRocketChatAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
