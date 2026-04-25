import { createHash } from "node:crypto";

import { normalizeRocketChatBaseUrl } from "./base-url.js";

export type RocketChatClient = {
  baseUrl: string;
  apiBaseUrl: string;
  authToken: string;
  userId: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type RocketChatUser = {
  _id: string;
  username?: string | null;
  name?: string | null;
  status?: string | null;
};

export type RocketChatRoom = {
  _id: string;
  name?: string | null;
  fname?: string | null;
  t?: string | null; // c, p, d, l
  topic?: string | null;
  teamId?: string | null;
};

export type RocketChatMessage = {
  _id: string;
  rid?: string | null;
  msg?: string | null;
  ts?: { $date: number } | string | null;
  u?: { _id: string; username?: string; name?: string } | null;
  tmid?: string | null; // thread message id (parent)
  file?: { _id: string; name?: string; type?: string } | null;
  files?: Array<{ _id: string; name?: string; type?: string }> | null;
  attachments?: Array<{
    title?: string;
    title_link?: string;
    image_url?: string;
    audio_url?: string;
    video_url?: string;
    type?: string;
  }> | null;
  t?: string | null; // system message type
};

export type RocketChatFileInfo = {
  _id: string;
  name?: string | null;
  type?: string | null;
  size?: number | null;
  url?: string | null;
};

function buildApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeRocketChatBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Rocket.Chat baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v1${suffix}`;
}

type RocketChatLoginSession = {
  authToken: string;
  userId: string;
};

type RocketChatLoginCacheEntry = {
  session?: RocketChatLoginSession;
  inFlight?: Promise<RocketChatLoginSession>;
};

const rocketChatLoginCache = new Map<string, RocketChatLoginCacheEntry>();
const MAX_LOGIN_RATE_LIMIT_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loginCacheKey(baseUrl: string, username: string, password: string): string {
  const passwordHash = createHash("sha256").update(password).digest("hex").slice(0, 16);
  return `${baseUrl}::${username}::sha256:${passwordHash}`;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const when = Date.parse(value);
  if (Number.isFinite(when)) {
    return Math.max(0, when - Date.now());
  }
  return undefined;
}

function parseRateLimitDelayMs(detail: string): number | undefined {
  const match = detail.match(/wait\s+(\d+)\s+seconds?/i);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, seconds * 1000);
}

async function readRocketChatError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { error?: string; message?: string } | undefined;
    if (data?.error) {
      return data.error;
    }
    if (data?.message) {
      return data.message;
    }
    return JSON.stringify(data);
  }
  return await res.text();
}

export function createRocketChatClient(params: {
  baseUrl: string;
  authToken: string;
  userId: string;
  fetchImpl?: typeof fetch;
}): RocketChatClient {
  const baseUrl = normalizeRocketChatBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Rocket.Chat baseUrl is required");
  }
  const apiBaseUrl = `${baseUrl}/api/v1`;
  const authToken = params.authToken.trim();
  const userId = params.userId.trim();
  const fetchImpl = params.fetchImpl ?? fetch;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const url = buildApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("X-Auth-Token", authToken);
    headers.set("X-User-Id", userId);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readRocketChatError(res);
      // Never include request headers in errors; keep the message to status + server-provided detail.
      throw new Error(
        `Rocket.Chat API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
      );
    }
    return (await res.json()) as T;
  };

  return { baseUrl, apiBaseUrl, authToken, userId, request };
}

export async function fetchMe(client: RocketChatClient): Promise<RocketChatUser> {
  const data = await client.request<{ _id: string; username?: string; name?: string }>("/me");
  return data;
}

export async function fetchUser(
  client: RocketChatClient,
  userId: string,
): Promise<RocketChatUser> {
  const data = await client.request<{ user: RocketChatUser }>(
    `/users.info?userId=${encodeURIComponent(userId)}`,
  );
  return data.user;
}

export async function fetchUserByUsername(
  client: RocketChatClient,
  username: string,
): Promise<RocketChatUser> {
  const data = await client.request<{ user: RocketChatUser }>(
    `/users.info?username=${encodeURIComponent(username)}`,
  );
  return data.user;
}

export async function fetchChannel(
  client: RocketChatClient,
  roomId: string,
): Promise<RocketChatRoom> {
  // Try channels.info first, fall back to rooms.info for all room types
  try {
    const data = await client.request<{ room: RocketChatRoom }>(
      `/rooms.info?roomId=${encodeURIComponent(roomId)}`,
    );
    return data.room;
  } catch {
    const data = await client.request<{ channel: RocketChatRoom }>(
      `/channels.info?roomId=${encodeURIComponent(roomId)}`,
    );
    return data.channel;
  }
}

export async function sendMessage(
  client: RocketChatClient,
  params: {
    roomId: string;
    text: string;
    tmid?: string; // thread message id
  },
): Promise<RocketChatMessage> {
  const message: Record<string, unknown> = {
    rid: params.roomId,
    msg: params.text,
  };
  if (params.tmid) {
    message.tmid = params.tmid;
  }
  const data = await client.request<{ message: RocketChatMessage }>("/chat.sendMessage", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  return data.message;
}

export type RocketChatTypingSender = (params: {
  roomId: string;
  username: string;
  typing: boolean;
}) => Promise<void>;

export async function sendTyping(
  client: RocketChatClient,
  params: {
    roomId: string;
    typing: boolean;
    username?: string;
    sendRealtimeTyping?: RocketChatTypingSender;
  },
): Promise<void> {
  const username = params.username?.trim();
  if (params.sendRealtimeTyping && username) {
    await params.sendRealtimeTyping({
      roomId: params.roomId,
      username,
      typing: params.typing,
    });
    return;
  }

  // Rocket.Chat typing is typically done via realtime/DDP, but there's no REST endpoint.
  // We'll use the REST method if available, otherwise this is a no-op.
  // In practice, typing indicators are sent via the DDP WebSocket.
  // This is a placeholder for the REST fallback.
  try {
    await client.request<Record<string, unknown>>("/chat.reportTyping", {
      method: "POST",
      body: JSON.stringify({
        roomId: params.roomId,
        typing: params.typing,
      }),
    });
  } catch {
    // Typing indicator endpoint may not exist in all RC versions; silently ignore.
  }
}

export async function uploadFile(
  client: RocketChatClient,
  params: {
    roomId: string;
    buffer: Buffer;
    fileName: string;
    contentType?: string;
    description?: string;
    tmid?: string;
  },
): Promise<RocketChatMessage> {
  // Step 1: Upload via rooms.media
  const form = new FormData();
  const bytes = Uint8Array.from(params.buffer);
  const blob = params.contentType
    ? new Blob([bytes], { type: params.contentType })
    : new Blob([bytes]);
  form.append("file", blob, params.fileName || "upload");
  if (params.description) {
    form.append("description", params.description);
  }
  if (params.tmid) {
    form.append("tmid", params.tmid);
  }

  const uploadUrl = `${client.apiBaseUrl}/rooms.media/${encodeURIComponent(params.roomId)}`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Auth-Token": client.authToken,
      "X-User-Id": client.userId,
    },
    body: form,
  });
  if (!uploadRes.ok) {
    const detail = await readRocketChatError(uploadRes);
    throw new Error(
      `Rocket.Chat API ${uploadRes.status} ${uploadRes.statusText}: ${detail || "unknown error"}`,
    );
  }
  const uploadData = (await uploadRes.json()) as {
    file?: { _id: string; url: string };
    success?: boolean;
  };
  if (!uploadData.success || !uploadData.file?.url) {
    throw new Error(
      `Rocket.Chat file upload failed: status=${uploadRes.status}, body=${JSON.stringify(uploadData)}`,
    );
  }

  // Step 2: Determine attachment type and absolute URL
  const mimeType = params.contentType ?? "";
  const fileName = params.fileName ?? "";
  const isAudio = mimeType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(fileName);
  const isVideo = mimeType.startsWith("video/") || /\.(mp4|webm|mov|avi|mkv)$/i.test(fileName);
  const isImage = mimeType.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(fileName);

  const absoluteUrl = uploadData.file.url.startsWith("http")
    ? uploadData.file.url
    : `${client.baseUrl}${uploadData.file.url}`;

  const attachment: Record<string, unknown> = {
    title: fileName,
    type: "file",
  };
  if (isAudio) {
    attachment.audio_url = absoluteUrl;
  } else if (isVideo) {
    attachment.video_url = absoluteUrl;
  } else if (isImage) {
    attachment.image_url = absoluteUrl;
  } else {
    attachment.title_link = absoluteUrl;
    attachment.title_link_download = true;
  }

  // Step 3: Post message with attachment
  const msgUrl = `${client.apiBaseUrl}/chat.postMessage`;
  const msgRes = await fetch(msgUrl, {
    method: "POST",
    headers: {
      "X-Auth-Token": client.authToken,
      "X-User-Id": client.userId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      roomId: params.roomId,
      text: params.description ?? "",
      tmid: params.tmid ?? undefined,
      attachments: [attachment],
    }),
  });
  if (!msgRes.ok) {
    const detail = await readRocketChatError(msgRes);
    throw new Error(
      `Rocket.Chat API ${msgRes.status} ${msgRes.statusText}: ${detail || "unknown error"}`,
    );
  }
  const msgData = (await msgRes.json()) as { message?: RocketChatMessage };
  if (!msgData.message) {
    throw new Error("Rocket.Chat file upload failed: no message returned");
  }
  return msgData.message;
}

export async function createDirectMessage(
  client: RocketChatClient,
  username: string,
): Promise<RocketChatRoom> {
  const data = await client.request<{ room: RocketChatRoom }>("/dm.create", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
  return data.room;
}

export async function createDirectMessageById(
  client: RocketChatClient,
  userIds: string[],
): Promise<RocketChatRoom> {
  // Use im.create for direct messages by user IDs
  const data = await client.request<{ room: RocketChatRoom }>("/im.create", {
    method: "POST",
    body: JSON.stringify({
      usernames: userIds.join(","),
    }),
  });
  return data.room;
}

/**
 * Login via username/password and return authToken + userId.
 * Use this when Personal Access Tokens are not available (e.g., Starter plan).
 * The returned token is valid until logout or server restart.
 */
export async function loginWithPassword(params: {
  baseUrl: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
}): Promise<{ authToken: string; userId: string }> {
  const baseUrl = normalizeRocketChatBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Rocket.Chat baseUrl is required for login");
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const key = loginCacheKey(baseUrl, params.username, params.password);
  const entry = rocketChatLoginCache.get(key) ?? {};
  if (params.forceRefresh) {
    delete entry.session;
  }
  if (entry.session) {
    rocketChatLoginCache.set(key, entry);
    return entry.session;
  }
  if (entry.inFlight) {
    rocketChatLoginCache.set(key, entry);
    return entry.inFlight;
  }

  const loginPromise = (async (): Promise<RocketChatLoginSession> => {
    const url = `${baseUrl}/api/v1/login`;
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: params.username, password: params.password }),
      });
      if (!res.ok) {
        const detail = await readRocketChatError(res);
        if (res.status === 429 && attempt < MAX_LOGIN_RATE_LIMIT_RETRIES) {
          const retryAfterMs =
            parseRetryAfterMs(res.headers.get("retry-after")) ?? parseRateLimitDelayMs(detail);
          if (retryAfterMs !== undefined) {
            await sleep(retryAfterMs);
            continue;
          }
        }
        throw new Error(`Rocket.Chat login failed (${res.status}): ${detail}`);
      }
      const data = (await res.json()) as {
        status?: string;
        data?: { authToken?: string; userId?: string };
      };
      const authToken = data.data?.authToken;
      const userId = data.data?.userId;
      if (!authToken || !userId) {
        throw new Error("Rocket.Chat login succeeded but no token/userId returned");
      }
      return { authToken, userId };
    }
  })();

  entry.inFlight = loginPromise;
  rocketChatLoginCache.set(key, entry);

  try {
    const session = await loginPromise;
    entry.session = session;
    return session;
  } finally {
    delete entry.inFlight;
    rocketChatLoginCache.set(key, entry);
  }
}
