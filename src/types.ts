import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/setup";

export type BlockStreamingCoalesceConfig = {
  minChars?: number;
  idleMs?: number;
};

export type RocketChatChatMode = "oncall" | "onmessage" | "onchar";

export type RocketChatRoomConfig = {
  /** Keep mention-gated group conversations active for N minutes after a mention. */
  conversationWindowMinutes?: number;
  /** Maximum outbound attachment size in megabytes for this room. */
  mediaMaxMb?: number;
};

export type RocketChatAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Rocket.Chat account. Default: true. */
  enabled?: boolean;
  /** Personal access token for Rocket.Chat. */
  authToken?: string;
  /** User ID associated with the auth token. */
  userId?: string;
  /** Username for login-based auth (alternative to authToken/userId). */
  username?: string;
  /** Password for login-based auth (alternative to authToken/userId). */
  password?: string;
  /** Base URL for the Rocket.Chat server (e.g., https://chat.example.com). */
  baseUrl?: string;
  /**
   * Controls when channel messages trigger replies.
   * - "oncall": only respond when mentioned
   * - "onmessage": respond to every channel message
   * - "onchar": respond when a trigger character prefixes the message
   */
  chatmode?: RocketChatChatMode;
  /** Prefix characters that trigger onchar mode (default: [">", "!"]). */
  oncharPrefixes?: string[];
  /** Require @mention to respond in channels. Default: true. */
  requireMention?: boolean;
  /** Keep mention-gated rooms active for N minutes after a mention. Disabled when unset or 0. */
  conversationWindowMinutes?: number;
  /** Maximum outbound attachment size in megabytes for this account. */
  mediaMaxMb?: number;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages (user ids or @usernames). */
  allowFrom?: Array<string | number>;
  /** Allowlist for group messages (user ids or @usernames). */
  groupAllowFrom?: Array<string | number>;
  /** Group message policy (allowlist/open/disabled). */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Optional per-room overrides keyed by Rocket.Chat room id. */
  rooms?: Record<string, RocketChatRoomConfig>;
};

export type RocketChatConfig = {
  /** Optional per-account Rocket.Chat configuration (multi-account). */
  accounts?: Record<string, RocketChatAccountConfig>;
} & RocketChatAccountConfig;
