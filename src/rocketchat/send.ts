import { createHash } from "node:crypto";

import { getRocketChatRuntime } from "../runtime.js";
import { resolveRocketChatAccount } from "./accounts.js";
import {
  createRocketChatClient,
  createDirectMessage,
  fetchMe,
  fetchUserByUsername,
  loginWithPassword,
  sendMessage,
  uploadFile,
  normalizeRocketChatBaseUrl,
  type RocketChatUser,
} from "./client.js";

export type RocketChatSendOpts = {
  authToken?: string;
  userId?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  replyToId?: string;
};

export type RocketChatSendResult = {
  messageId: string;
  roomId: string;
};

type RocketChatTarget =
  | { kind: "channel"; id: string }
  | { kind: "user"; id?: string; username?: string };

const botUserCache = new Map<string, RocketChatUser>();
const userByNameCache = new Map<string, RocketChatUser>();

const getCore = () => getRocketChatRuntime();

function cacheKey(baseUrl: string, token: string): string {
  // Never place raw secrets into cache keys (they can show up in debug tooling, heap dumps, etc.)
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return `${baseUrl}::sha256:${tokenHash}`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function parseRocketChatTarget(raw: string): RocketChatTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Rocket.Chat sends");
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) throw new Error("Channel id is required");
    return { kind: "channel", id };
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    if (!id) throw new Error("User id is required");
    return { kind: "user", id };
  }
  if (lower.startsWith("rocketchat:")) {
    const id = trimmed.slice("rocketchat:".length).trim();
    if (!id) throw new Error("User id is required");
    return { kind: "user", id };
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    if (!username) throw new Error("Username is required");
    return { kind: "user", username };
  }
  return { kind: "channel", id: trimmed };
}

async function resolveTargetRoomId(params: {
  target: RocketChatTarget;
  baseUrl: string;
  authToken: string;
  userId: string;
}): Promise<string> {
  if (params.target.kind === "channel") {
    return params.target.id;
  }

  const client = createRocketChatClient({
    baseUrl: params.baseUrl,
    authToken: params.authToken,
    userId: params.userId,
  });

  // For user targets, create a DM
  if (params.target.username) {
    const room = await createDirectMessage(client, params.target.username);
    return room._id;
  }

  // For user ID targets, look up username first then create DM
  if (params.target.id) {
    const key = `${cacheKey(params.baseUrl, params.authToken)}::id:${params.target.id}`;
    let user = userByNameCache.get(key);
    if (!user) {
      const { fetchUser } = await import("./client.js");
      user = await fetchUser(client, params.target.id);
      userByNameCache.set(key, user);
    }
    const username = user.username?.trim();
    if (!username) {
      throw new Error(`Cannot resolve username for user ${params.target.id}`);
    }
    const room = await createDirectMessage(client, username);
    return room._id;
  }

  throw new Error("Cannot resolve Rocket.Chat target");
}

export async function sendMessageRocketChat(
  to: string,
  text: string,
  opts: RocketChatSendOpts = {},
): Promise<RocketChatSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "rocketchat" });
  const cfg = core.config.loadConfig();
  const account = resolveRocketChatAccount({
    cfg,
    accountId: opts.accountId,
  });
  let authToken = opts.authToken?.trim() || account.authToken?.trim();
  let userId = opts.userId?.trim() || account.userId?.trim();
  const baseUrl = normalizeRocketChatBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Rocket.Chat baseUrl missing for account "${account.accountId}".`,
    );
  }

  // Fall back to username/password login if no token
  if (!authToken || !userId) {
    const username = account.username?.trim();
    const password = account.password?.trim();
    if (username && password && baseUrl) {
      const loginResult = await loginWithPassword({ baseUrl, username, password });
      authToken = loginResult.authToken;
      userId = loginResult.userId;
    } else {
      throw new Error(
        `Rocket.Chat auth missing for account "${account.accountId}". Set authToken+userId or username+password.`,
      );
    }
  }

  const target = parseRocketChatTarget(to);
  const roomId = await resolveTargetRoomId({
    target,
    baseUrl,
    authToken,
    userId,
  });

  const client = createRocketChatClient({ baseUrl, authToken, userId });
  let message = text?.trim() ?? "";
  let uploadError: Error | undefined;
  const mediaUrl = opts.mediaUrl?.trim();

  if (mediaUrl) {
    try {
      const media = await core.media.loadWebMedia(mediaUrl);
      const result = await uploadFile(client, {
        roomId,
        buffer: media.buffer,
        fileName: media.fileName ?? "upload",
        contentType: media.contentType ?? undefined,
        description: message || undefined,
        tmid: opts.replyToId,
      });

      core.channel.activity.record({
        channel: "rocketchat",
        accountId: account.accountId,
        direction: "outbound",
      });

      return {
        messageId: result._id ?? "unknown",
        roomId,
      };
    } catch (err) {
      uploadError = err instanceof Error ? err : new Error(String(err));
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(
          `rocketchat send: media upload failed, falling back to URL text: ${String(err)}`,
        );
      }
      if (isHttpUrl(mediaUrl)) {
        message = [message, mediaUrl].filter(Boolean).join("\n");
      }
    }
  }

  if (message) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "rocketchat",
      accountId: account.accountId,
    });
    message = core.channel.text.convertMarkdownTables(message, tableMode);
  }

  if (!message) {
    if (uploadError) {
      throw new Error(`Rocket.Chat media upload failed: ${uploadError.message}`);
    }
    throw new Error("Rocket.Chat message is empty");
  }

  const result = await sendMessage(client, {
    roomId,
    text: message,
    tmid: opts.replyToId,
  });

  core.channel.activity.record({
    channel: "rocketchat",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: result._id ?? "unknown",
    roomId,
  };
}
