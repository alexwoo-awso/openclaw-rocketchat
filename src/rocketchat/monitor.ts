import type {
  ChannelAccountSnapshot,
  ChatType,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  resolveChannelMediaMaxBytes,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import { getRocketChatRuntime } from "../runtime.js";
import { resolveRocketChatAccount } from "./accounts.js";
import {
  createRocketChatClient,
  fetchChannel,
  fetchMe,
  fetchUser,
  sendTyping,
  loginWithPassword,
  normalizeRocketChatBaseUrl,
  type RocketChatRoom,
  type RocketChatMessage,
  type RocketChatUser,
} from "./client.js";
import { createRealtimeConnection } from "./realtime.js";
import { runWithReconnect } from "./reconnect.js";
import { sendMessageRocketChat } from "./send.js";

export type MonitorRocketChatOpts = {
  authToken?: string;
  userId?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const ROOM_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;

// Simple dedup cache
function createDedupeCache(options: { ttlMs: number; maxSize: number }) {
  const cache = new Map<string, number>();
  return {
    check: (key: string | undefined | null, now = Date.now()): boolean => {
      if (!key) return false;
      const existing = cache.get(key);
      if (existing !== undefined && now - existing < options.ttlMs) {
        cache.delete(key);
        cache.set(key, now);
        return true;
      }
      cache.delete(key);
      cache.set(key, now);
      // Prune
      if (cache.size > options.maxSize) {
        const cutoff = now - options.ttlMs;
        for (const [k, v] of cache) {
          if (v < cutoff) cache.delete(k);
        }
        while (cache.size > options.maxSize) {
          const oldest = cache.keys().next().value as string | undefined;
          if (!oldest) break;
          cache.delete(oldest);
        }
      }
      return false;
    },
  };
}

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_MESSAGE_TTL_MS,
  maxSize: RECENT_MESSAGE_MAX,
});

function resolveRuntime(opts: MonitorRocketChatOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) return text.trim();
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escaped}\\b`, "gi");
  return text.replace(re, " ").replace(/\s+/g, " ").trim();
}

function isSystemMessage(msg: RocketChatMessage): boolean {
  return Boolean(msg.t?.trim());
}

function roomKind(roomType?: string | null): ChatType {
  if (!roomType) return "channel";
  const t = roomType.trim().toLowerCase();
  if (t === "d") return "direct";
  if (t === "p") return "group";
  if (t === "l") return "direct"; // livechat treated as direct
  return "channel"; // c or anything else
}

function channelChatType(kind: ChatType): "direct" | "group" | "channel" {
  if (kind === "direct") return "direct";
  if (kind === "group") return "group";
  return "channel";
}

function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  return trimmed
    .replace(/^(rocketchat|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  const normalized = entries.map((e) => normalizeAllowEntry(String(e))).filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
}): boolean {
  const { allowFrom } = params;
  if (allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const nId = normalizeAllowEntry(params.senderId);
  const nName = params.senderName ? normalizeAllowEntry(params.senderName) : "";
  return allowFrom.some((e) => e === nId || (nName && e === nName));
}

function extractMessageTimestamp(msg: RocketChatMessage): number | undefined {
  if (!msg.ts) return undefined;
  if (typeof msg.ts === "object" && "$date" in msg.ts) return msg.ts.$date;
  if (typeof msg.ts === "string") return new Date(msg.ts).getTime();
  return undefined;
}

type RocketChatMediaInfo = {
  path: string;
  contentType?: string;
  kind: MediaKind;
};

function buildAttachmentPlaceholder(mediaList: RocketChatMediaInfo[]): string {
  if (mediaList.length === 0) return "";
  if (mediaList.length === 1) {
    const kind = mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind;
    return `<media:${kind}>`;
  }
  const allImages = mediaList.every((m) => m.kind === "image");
  const label = allImages ? "image" : "file";
  const suffix = mediaList.length === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${mediaList.length} ${suffix})`;
}

function buildMediaPayload(mediaList: RocketChatMediaInfo[]) {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList.map((m) => m.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

const DEFAULT_ONCHAR_PREFIXES = [">", "!"];

function resolveOncharPrefixes(prefixes: string[] | undefined): string[] {
  const cleaned = prefixes?.map((e) => e.trim()).filter(Boolean) ?? DEFAULT_ONCHAR_PREFIXES;
  return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}

function stripOncharPrefix(
  text: string,
  prefixes: string[],
): { triggered: boolean; stripped: string } {
  const trimmed = text.trimStart();
  for (const prefix of prefixes) {
    if (!prefix) continue;
    if (trimmed.startsWith(prefix)) {
      return { triggered: true, stripped: trimmed.slice(prefix.length).trimStart() };
    }
  }
  return { triggered: false, stripped: text };
}

function formatInboundFromLabel(params: {
  isGroup: boolean;
  groupLabel?: string;
  groupId?: string;
  directLabel: string;
  directId?: string;
  groupFallback?: string;
}): string {
  if (params.isGroup) {
    const label = params.groupLabel?.trim() || params.groupFallback || "Group";
    const id = params.groupId?.trim();
    return id ? `${label} id:${id}` : label;
  }
  const directLabel = params.directLabel.trim();
  const directId = params.directId?.trim();
  if (!directId || directId === directLabel) return directLabel;
  return `${directLabel} id:${directId}`;
}

export async function monitorRocketChatProvider(opts: MonitorRocketChatOpts = {}): Promise<void> {
  const core = getRocketChatRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveRocketChatAccount({
    cfg,
    accountId: opts.accountId,
  });
  const baseUrl = normalizeRocketChatBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Rocket.Chat baseUrl missing for account "${account.accountId}" (set channels.rocketchat.baseUrl or ROCKETCHAT_URL).`,
    );
  }

  // Resolve auth: prefer authToken/userId, fall back to username/password login.
  // If username/password is configured, we can re-login automatically when a token expires.
  let authToken = opts.authToken?.trim() || account.authToken?.trim();
  let userId = opts.userId?.trim() || account.userId?.trim();
  const username = account.username?.trim();
  const password = account.password?.trim();
  const canRelogin = Boolean(username && password);

  let reloginNeeded = false;
  const relogin = async (): Promise<void> => {
    if (!canRelogin || !username || !password) return;
    const loginResult = await loginWithPassword({ baseUrl, username, password });
    authToken = loginResult.authToken;
    userId = loginResult.userId;
  };

  if (!authToken || !userId) {
    if (canRelogin) {
      await relogin();
    } else {
      throw new Error(
        `Rocket.Chat auth missing for account "${account.accountId}". Set authToken+userId, or username+password, or env vars ROCKETCHAT_AUTH_TOKEN+ROCKETCHAT_USER_ID.`,
      );
    }
  }

  let client = createRocketChatClient({ baseUrl, authToken, userId });
  const botUser = await fetchMe(client);
  const botUserId = botUser._id;
  const botUsername = botUser.username?.trim() || undefined;
  runtime.log?.(`rocketchat connected as ${botUsername ? `@${botUsername}` : botUserId}`);

  const roomCache = new Map<string, { value: RocketChatRoom | null; expiresAt: number }>();
  const userCache = new Map<string, { value: RocketChatUser | null; expiresAt: number }>();
  const logger = core.logging.getChildLogger({ module: "rocketchat" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) return;
    logger.debug?.(message);
  };
  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => undefined,
      accountId: account.accountId,
    }) ?? 8 * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();

  const fetchWithAuth = (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Auth-Token", client.authToken);
    headers.set("X-User-Id", client.userId);
    return fetch(input, { ...init, headers });
  };

  const resolveMedia = async (msg: RocketChatMessage): Promise<RocketChatMediaInfo[]> => {
    const out: RocketChatMediaInfo[] = [];

    // Handle file attachments
    const files = msg.files ?? (msg.file ? [msg.file] : []);
    for (const file of files) {
      if (!file._id) continue;
      try {
        const url = `${client.apiBaseUrl}/files/${file._id}`;
        const fetched = await core.channel.media.fetchRemoteMedia({
          url,
          fetchImpl: fetchWithAuth,
          filePathHint: file.name ?? file._id,
          maxBytes: mediaMaxBytes,
        });
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? undefined,
          "inbound",
          mediaMaxBytes,
        );
        const contentType = saved.contentType ?? fetched.contentType ?? undefined;
        out.push({
          path: saved.path,
          contentType,
          kind: core.media.mediaKindFromMime(contentType),
        });
      } catch (err) {
        logger.debug?.(`rocketchat: failed to download file ${file._id}: ${String(err)}`);
      }
    }

    // Handle URL-based attachments (image_url, audio_url, video_url)
    const attachments = msg.attachments ?? [];
    for (const att of attachments) {
      const attUrl = att.image_url ?? att.audio_url ?? att.video_url;
      if (!attUrl) continue;
      const fullUrl = attUrl.startsWith("http") ? attUrl : `${client.baseUrl}${attUrl}`;
      try {
        const fetched = await core.channel.media.fetchRemoteMedia({
          url: fullUrl,
          fetchImpl: fetchWithAuth,
          filePathHint: att.title ?? "attachment",
          maxBytes: mediaMaxBytes,
        });
        const saved = await core.channel.media.saveMediaBuffer(
          fetched.buffer,
          fetched.contentType ?? undefined,
          "inbound",
          mediaMaxBytes,
        );
        const contentType = saved.contentType ?? fetched.contentType ?? undefined;
        out.push({
          path: saved.path,
          contentType,
          kind: core.media.mediaKindFromMime(contentType),
        });
      } catch (err) {
        logger.debug?.(`rocketchat: failed to download attachment: ${String(err)}`);
      }
    }

    return out;
  };

  const sendTypingIndicator = async (roomId: string) => {
    await sendTyping(client, { roomId, typing: true });
  };

  const resolveRoomInfo = async (roomId: string): Promise<RocketChatRoom | null> => {
    const cached = roomCache.get(roomId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const info = await fetchChannel(client, roomId);
      roomCache.set(roomId, { value: info, expiresAt: Date.now() + ROOM_CACHE_TTL_MS });
      return info;
    } catch (err) {
      logger.debug?.(`rocketchat: room lookup failed: ${String(err)}`);
      roomCache.set(roomId, { value: null, expiresAt: Date.now() + ROOM_CACHE_TTL_MS });
      return null;
    }
  };

  const resolveUserInfo = async (uid: string): Promise<RocketChatUser | null> => {
    const cached = userCache.get(uid);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const info = await fetchUser(client, uid);
      userCache.set(uid, { value: info, expiresAt: Date.now() + USER_CACHE_TTL_MS });
      return info;
    } catch (err) {
      logger.debug?.(`rocketchat: user lookup failed: ${String(err)}`);
      userCache.set(uid, { value: null, expiresAt: Date.now() + USER_CACHE_TTL_MS });
      return null;
    }
  };

  const handleMessage = async (roomId: string, msg: RocketChatMessage) => {
    const messageId = msg._id;
    if (!messageId) return;

    // Deduplicate
    if (recentInboundMessages.check(`${account.accountId}:${messageId}`)) return;

    // Skip own messages
    const senderId = msg.u?._id;
    if (!senderId) return;
    if (senderId === botUserId) return;

    // Skip system messages
    if (isSystemMessage(msg)) return;

    const roomInfo = await resolveRoomInfo(roomId);
    const roomType = roomInfo?.t ?? undefined;
    const kind = roomKind(roomType);
    const chatType = channelChatType(kind);

    const senderName =
      msg.u?.username?.trim() ||
      (await resolveUserInfo(senderId))?.username?.trim() ||
      senderId;
    const rawText = msg.msg?.trim() || "";
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
    const configAllowFrom = normalizeAllowList(account.config.allowFrom ?? []);
    const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom ?? []);
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing.readAllowFromStore("rocketchat").catch(() => []),
    );
    const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
    const effectiveGroupAllowFrom = Array.from(
      new Set([
        ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
        ...storeAllowFrom,
      ]),
    );
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "rocketchat",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const isControlCommand = allowTextCommands && hasControlCommand;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const senderAllowedForCommands = isSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveAllowFrom,
    });
    const groupAllowedForCommands = isSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveGroupAllowFrom,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands,
      hasControlCommand,
    });
    const commandAuthorized =
      kind === "direct"
        ? dmPolicy === "open" || senderAllowedForCommands
        : commandGate.commandAuthorized;

    // DM access control
    if (kind === "direct") {
      if (dmPolicy === "disabled") {
        logVerboseMessage(`rocketchat: drop dm (dmPolicy=disabled sender=${senderId})`);
        return;
      }
      if (dmPolicy !== "open" && !senderAllowedForCommands) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "rocketchat",
            id: senderId,
            meta: { name: senderName },
          });
          logVerboseMessage(`rocketchat: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessageRocketChat(`user:${senderId}`, core.channel.pairing.buildPairingReply({
                channel: "rocketchat",
                idLine: `Your Rocket.Chat user id: ${senderId}`,
                code,
              }), { accountId: account.accountId });
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerboseMessage(`rocketchat: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerboseMessage(`rocketchat: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
        }
        return;
      }
    } else {
      // Group access control
      if (groupPolicy === "disabled") {
        logVerboseMessage("rocketchat: drop group message (groupPolicy=disabled)");
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          logVerboseMessage("rocketchat: drop group message (no group allowlist)");
          return;
        }
        if (!groupAllowedForCommands) {
          logVerboseMessage(`rocketchat: drop group sender=${senderId} (not in groupAllowFrom)`);
          return;
        }
      }
    }

    if (kind !== "direct" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerboseMessage,
        channel: "rocketchat",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const roomName = roomInfo?.name ?? "";
    const roomDisplay = roomInfo?.fname ?? roomName;
    const roomLabel = roomName ? `#${roomName}` : roomDisplay || `#${roomId}`;
    const teamId = roomInfo?.teamId ?? undefined;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "rocketchat",
      accountId: account.accountId,
      teamId,
      peer: {
        kind,
        id: kind === "direct" ? senderId : roomId,
      },
    });

    const baseSessionKey = route.sessionKey;
    const threadRootId = msg.tmid?.trim() || undefined;
    const sessionKey = threadRootId
      ? `${baseSessionKey}:thread:${threadRootId}`
      : baseSessionKey;
    const parentSessionKey = threadRootId ? baseSessionKey : undefined;
    const historyKey = kind === "direct" ? null : sessionKey;

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    const wasMentioned =
      kind !== "direct" &&
      ((botUsername ? rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`) : false) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));

    const pendingBody =
      rawText ||
      (msg.file ? "[Rocket.Chat file]" : msg.attachments?.length ? "[Rocket.Chat attachment]" : "");
    const pendingSender = senderName;
    const msgTimestamp = extractMessageTimestamp(msg);

    const recordPendingHistory = () => {
      const trimmed = pendingBody.trim();
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: pendingSender,
                body: trimmed,
                timestamp: msgTimestamp,
                messageId: msg._id ?? undefined,
              }
            : null,
      });
    };

    const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
    const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
    const oncharResult = oncharEnabled
      ? stripOncharPrefix(rawText, oncharPrefixes)
      : { triggered: false, stripped: rawText };
    const oncharTriggered = oncharResult.triggered;

    const shouldRequireMention =
      kind !== "direct" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "rocketchat",
        accountId: account.accountId,
        groupId: roomId,
      });
    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention || oncharTriggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;

    if (oncharEnabled && !oncharTriggered && !wasMentioned && !isControlCommand) {
      recordPendingHistory();
      return;
    }

    if (kind !== "direct" && shouldRequireMention && canDetectMention) {
      if (!effectiveWasMentioned) {
        recordPendingHistory();
        return;
      }
    }

    const mediaList = await resolveMedia(msg);
    const mediaPlaceholder = buildAttachmentPlaceholder(mediaList);
    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const baseText = [bodySource, mediaPlaceholder].filter(Boolean).join("\n").trim();
    const bodyText = normalizeMention(baseText, botUsername);
    if (!bodyText) return;

    core.channel.activity.record({
      channel: "rocketchat",
      accountId: account.accountId,
      direction: "inbound",
    });

    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: roomDisplay || roomLabel,
      groupId: roomId,
      groupFallback: roomLabel || "Channel",
      directLabel: senderName,
      directId: senderId,
    });

    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "direct"
        ? `Rocket.Chat DM from ${senderName}`
        : `Rocket.Chat message in ${roomLabel} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `rocketchat:message:${roomId}:${msg._id ?? "unknown"}`,
    });

    const textWithId = `${bodyText}\n[rocketchat message id: ${msg._id ?? "unknown"} room: ${roomId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Rocket.Chat",
      from: fromLabel,
      timestamp: msgTimestamp,
      body: textWithId,
      chatType,
      sender: { name: senderName, id: senderId },
    });
    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatInboundEnvelope({
            channel: "Rocket.Chat",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} room:${roomId}]` : ""
            }`,
            chatType,
            senderLabel: entry.sender,
          }),
      });
    }

    const to = kind === "direct" ? `user:${senderId}` : `channel:${roomId}`;
    const mediaPayload = buildMediaPayload(mediaList);
    const inboundHistory =
      historyKey && historyLimit > 0
        ? (channelHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyText,
      InboundHistory: inboundHistory,
      RawBody: bodyText,
      CommandBody: bodyText,
      From:
        kind === "direct"
          ? `rocketchat:${senderId}`
          : kind === "group"
            ? `rocketchat:group:${roomId}`
            : `rocketchat:channel:${roomId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? roomDisplay || roomLabel : undefined,
      GroupChannel: roomName ? `#${roomName}` : undefined,
      GroupSpace: teamId,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "rocketchat" as const,
      Surface: "rocketchat" as const,
      MessageSid: msg._id ?? undefined,
      ReplyToId: threadRootId,
      MessageThreadId: threadRootId,
      Timestamp: msgTimestamp,
      WasMentioned: kind !== "direct" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "rocketchat" as const,
      OriginatingTo: to,
      ...mediaPayload,
    });

    if (kind === "direct") {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "rocketchat",
          to,
          accountId: route.accountId,
        },
      });
    }

    const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
    logVerboseMessage(
      `rocketchat inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "rocketchat",
      account.accountId,
      { fallbackLimit: account.textChunkLimit ?? 4000 },
    );
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "rocketchat",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "rocketchat",
      accountId: account.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
      start: () => sendTypingIndicator(roomId),
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logger.debug?.(message),
          channel: "rocketchat",
          target: roomId,
          error: err,
        });
      },
    });
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload: ReplyPayload) => {
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(
              cfg,
              "rocketchat",
              account.accountId,
            );
            const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
            for (const chunk of chunks.length > 0 ? chunks : [text]) {
              if (!chunk) continue;
              await sendMessageRocketChat(to, chunk, {
                accountId: account.accountId,
                replyToId: threadRootId,
              });
            }
          } else {
            let first = true;
            for (const mediaUrl of mediaUrls) {
              const caption = first ? text : "";
              first = false;
              await sendMessageRocketChat(to, caption, {
                accountId: account.accountId,
                mediaUrl,
                replyToId: threadRootId,
              });
            }
          }
          runtime.log?.(`delivered reply`);
        },
        onError: (err, info) => {
          runtime.error?.(`rocketchat ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
      });

    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming:
          typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
        onModelSelected,
      },
    });
    markDispatchIdle();
    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };

  // Debouncer for inbound messages
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "rocketchat",
  });
  const debouncer = core.channel.debounce.createInboundDebouncer<{
    roomId: string;
    msg: RocketChatMessage;
  }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const threadId = entry.msg.tmid?.trim();
      const threadKey = threadId ? `thread:${threadId}` : "room";
      return `rocketchat:${account.accountId}:${entry.roomId}:${threadKey}`;
    },
    shouldDebounce: (entry) => {
      if (entry.msg.file || entry.msg.files?.length) return false;
      const text = entry.msg.msg?.trim() ?? "";
      if (!text) return false;
      return !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await handleMessage(last.roomId, last.msg);
        return;
      }
      const combinedText = entries
        .map((e) => e.msg.msg?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
      const mergedMsg: RocketChatMessage = {
        ...last.msg,
        msg: combinedText,
        file: undefined,
        files: undefined,
        attachments: undefined,
      };
      await handleMessage(last.roomId, mergedMsg);
    },
    onError: (err) => {
      runtime.error?.(`rocketchat debounce flush failed: ${String(err)}`);
    },
  });

  const connectOnce = async (): Promise<void> => {
    if (reloginNeeded) {
      await relogin();
      client = createRocketChatClient({ baseUrl, authToken, userId });
      reloginNeeded = false;
    }
    return createRealtimeConnection({
      baseUrl,
      authToken,
      abortSignal: opts.abortSignal,
      callbacks: {
        onMessage: (roomId, message) => {
          debouncer.enqueue({ roomId, msg: message }).catch((err) => {
            runtime.error?.(`rocketchat handler failed: ${String(err)}`);
          });
        },
        onConnected: () => {
          opts.statusSink?.({
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
        },
        onDisconnected: (code, reason) => {
          opts.statusSink?.({
            connected: false,
            lastDisconnect: {
              at: Date.now(),
              status: code,
              error: reason || undefined,
            },
          });
        },
        onError: (err) => {
          runtime.error?.(`rocketchat websocket error: ${String(err)}`);
          opts.statusSink?.({ lastError: String(err) });
        },
      },
    });
  };

  await runWithReconnect(connectOnce, {
    abortSignal: opts.abortSignal,
    onError: (err) => {
      const msg = String(err);

      // If the token was obtained via username/password login, we can recover by re-logging in
      // before the next reconnect attempt.
      if (canRelogin && msg.includes("DDP login failed")) {
        runtime.error?.(`rocketchat auth failed; will re-login before reconnecting...`);
        reloginNeeded = true;
      }

      runtime.error?.(`rocketchat connection failed: ${msg}`);
      opts.statusSink?.({ lastError: msg, connected: false });
    },
    onReconnect: (delayMs) => {
      runtime.log?.(`rocketchat reconnecting in ${Math.round(delayMs / 1000)}s`);
    },
  });
}
