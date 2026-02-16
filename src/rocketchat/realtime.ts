import WebSocket from "ws";
import type { RocketChatMessage } from "./client.js";

export type DDPMessage = {
  msg?: string;
  id?: string;
  method?: string;
  collection?: string;
  fields?: {
    eventName?: string;
    args?: unknown[];
  };
  result?: unknown;
  error?: unknown;
};

export type RealtimeCallbacks = {
  onMessage: (roomId: string, message: RocketChatMessage) => void;
  onConnected?: () => void;
  onDisconnected?: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
};

let ddpIdCounter = 0;
function nextDdpId(): string {
  return `openclaw-${++ddpIdCounter}`;
}

/**
 * Create a DDP WebSocket connection to Rocket.Chat for realtime message streaming.
 *
 * Includes a watchdog timer that detects stale connections (e.g. after VM
 * suspend/resume or network changes). If no DDP message is received within
 * `watchdogTimeoutMs` (default 120s), the WebSocket is force-terminated so the
 * reconnect loop can establish a fresh connection.
 */
export function createRealtimeConnection(params: {
  baseUrl: string;
  authToken: string;
  callbacks: RealtimeCallbacks;
  abortSignal?: AbortSignal;
  /** Max silence before force-terminating (ms). Default 120 000. */
  watchdogTimeoutMs?: number;
}): Promise<void> {
  const { baseUrl, authToken, callbacks, abortSignal } = params;
  const watchdogTimeout = params.watchdogTimeoutMs ?? 120_000;

  // Build WebSocket URL
  const wsBase = baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
  const wsUrl = `${wsBase}/websocket`;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let opened = false;
    let authenticated = false;

    // --- Watchdog: detect stale connections (VM suspend/resume, network drop) ---
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        // No DDP traffic for too long — connection is likely dead
        callbacks.onError?.(new Error("DDP watchdog timeout — no traffic, terminating stale connection"));
        ws.terminate();
      }, watchdogTimeout);
    };

    const clearWatchdog = () => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };
    // --- end watchdog ---

    const onAbort = () => { clearWatchdog(); ws.terminate(); };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearWatchdog();
      abortSignal?.removeEventListener("abort", onAbort);
    };

    // Send a DDP message
    const ddpSend = (msg: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on("open", () => {
      opened = true;
      resetWatchdog();
      // Step 1: DDP connect
      ddpSend({
        msg: "connect",
        version: "1",
        support: ["1"],
      });
    });

    ws.on("message", (raw) => {
      // Any incoming message proves the connection is alive — reset watchdog
      resetWatchdog();

      let data: DDPMessage;
      try {
        const str = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
        data = JSON.parse(str) as DDPMessage;
      } catch {
        return;
      }

      // Handle DDP ping/pong keepalive
      if (data.msg === "ping") {
        ddpSend({ msg: "pong", id: data.id });
        return;
      }

      // Step 2: On connected, authenticate
      if (data.msg === "connected") {
        ddpSend({
          msg: "method",
          method: "login",
          id: nextDdpId(),
          params: [{ resume: authToken }],
        });
        return;
      }

      // Step 3: On login result, subscribe to messages
      if (data.msg === "result" && !authenticated) {
        if (data.error) {
          const errMsg = typeof data.error === "object"
            ? (data.error as { message?: string }).message ?? JSON.stringify(data.error)
            : String(data.error);
          cleanup();
          reject(new Error(`Rocket.Chat DDP login failed: ${errMsg}`));
          return;
        }
        authenticated = true;
        callbacks.onConnected?.();

        // Subscribe to all messages for the authenticated user
        ddpSend({
          msg: "sub",
          id: nextDdpId(),
          name: "stream-room-messages",
          params: ["__my_messages__", { useCollection: false, args: [] }],
        });

        // Start client-side DDP pings to proactively detect dead connections
        // (e.g. after VM suspend/resume where server pings won't arrive)
        const clientPingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ddpSend({ msg: "ping", id: nextDdpId() });
          }
        }, 30_000);
        ws.once("close", () => clearInterval(clientPingInterval));

        return;
      }

      // Step 4: Handle incoming messages
      if (data.msg === "changed" && data.collection === "stream-room-messages") {
        const args = data.fields?.args;
        if (Array.isArray(args) && args.length > 0) {
          const message = args[0] as RocketChatMessage;
          if (message && message._id) {
            // Use message.rid (actual room ID), NOT eventName which is "__my_messages__"
            const roomId = (message.rid as string) ?? data.fields?.eventName;
            if (roomId && roomId !== "__my_messages__") {
              callbacks.onMessage(roomId, message);
            }
          }
        }
        return;
      }
    });

    ws.on("close", (code, reason) => {
      clearWatchdog();
      cleanup();
      const reasonStr = reason?.toString("utf8") ?? "";
      callbacks.onDisconnected?.(code, reasonStr);
      if (opened) {
        resolve();
      } else {
        reject(new Error(`Rocket.Chat WebSocket closed before open (code ${code})`));
      }
    });

    ws.on("error", (err) => {
      callbacks.onError?.(err);
      ws.close();
    });
  });
}
