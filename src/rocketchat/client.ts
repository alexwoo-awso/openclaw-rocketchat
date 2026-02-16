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

export function normalizeRocketChatBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
}

function buildApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeRocketChatBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Rocket.Chat baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v1${suffix}`;
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

export async function sendTyping(
  client: RocketChatClient,
  params: { roomId: string; typing: boolean },
): Promise<void> {
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

  const url = `${client.apiBaseUrl}/rooms.upload/${encodeURIComponent(params.roomId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Auth-Token": client.authToken,
      "X-User-Id": client.userId,
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await readRocketChatError(res);
    throw new Error(
      `Rocket.Chat API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
    );
  }

  const data = (await res.json()) as { message?: RocketChatMessage };
  if (!data.message) {
    throw new Error("Rocket.Chat file upload failed: no message returned");
  }
  return data.message;
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
}): Promise<{ authToken: string; userId: string }> {
  const baseUrl = normalizeRocketChatBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Rocket.Chat baseUrl is required for login");
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = `${baseUrl}/api/v1/login`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: params.username, password: params.password }),
  });
  if (!res.ok) {
    const detail = await readRocketChatError(res);
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
