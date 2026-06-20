import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type WebSocket from "ws";

import { createRocketChatClient, sendTyping } from "../src/rocketchat/client.js";
import { createRealtimeConnection, type RealtimeControls } from "../src/rocketchat/realtime.js";

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("sendTyping prefers realtime typing sender over REST fallback", async () => {
  let restCalls = 0;
  const client = createRocketChatClient({
    baseUrl: "https://chat.example.com",
    authToken: "token-123",
    userId: "user-123",
    fetchImpl: (async () => {
      restCalls += 1;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const typingCalls: Array<{ roomId: string; identities: string[]; typing: boolean }> = [];

  await sendTyping(client, {
    roomId: "ROOM1",
    typing: true,
    identities: ["Bot Test", "bot-test"],
    sendRealtimeTyping: async (params) => {
      typingCalls.push(params);
    },
  });

  assert.deepEqual(typingCalls, [
    { roomId: "ROOM1", identities: ["Bot Test", "bot-test"], typing: true },
  ]);
  assert.equal(restCalls, 0);
});

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];

  readyState = 1;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate() {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from("terminated"));
  }
}

test("realtime controls retry room typing with fallback identity after DDP rejection", async () => {
  FakeWebSocket.instances.length = 0;
  let controls: RealtimeControls | undefined;
  let socket: FakeWebSocket | undefined;

  const connection = createRealtimeConnection({
    baseUrl: "https://chat.example.com",
    authToken: "token-123",
    callbacks: {
      onMessage: () => {},
      onReady: (value) => {
        controls = value;
      },
    },
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });

  try {
    socket = FakeWebSocket.instances[0];
    assert.ok(socket);

    socket.emit("open");
    assert.deepEqual(JSON.parse(socket.sent[0] ?? "{}"), {
      msg: "connect",
      version: "1",
      support: ["1"],
    });

    socket.emit("message", Buffer.from(JSON.stringify({ msg: "connected" })));
    const loginPayload = JSON.parse(socket.sent[1] ?? "{}") as {
      msg?: string;
      method?: string;
      params?: Array<Record<string, string>>;
    };
    assert.equal(loginPayload.msg, "method");
    assert.equal(loginPayload.method, "login");
    assert.deepEqual(loginPayload.params, [{ resume: "token-123" }]);

    socket.emit("message", Buffer.from(JSON.stringify({ msg: "result", result: {} })));
    assert.ok(controls);

    const startTypingPromise = controls.sendTyping({
      roomId: "ROOM1",
      identities: ["Bot Test", "bot-test"],
      typing: true,
    });

    const firstUserActivityPayload = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      msg?: string;
      id?: string;
      method?: string;
      params?: unknown[];
    };
    assert.equal(firstUserActivityPayload.msg, "method");
    assert.equal(firstUserActivityPayload.method, "stream-notify-room");
    assert.deepEqual(firstUserActivityPayload.params, [
      "ROOM1/user-activity",
      "Bot Test",
      ["user-typing"],
      {},
    ]);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          msg: "result",
          id: firstUserActivityPayload.id,
          error: { message: "identity mismatch" },
        }),
      ),
    );
    await nextTurn();

    const fallbackUserActivityPayload = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      msg?: string;
      id?: string;
      method?: string;
      params?: unknown[];
    };
    assert.equal(fallbackUserActivityPayload.msg, "method");
    assert.equal(fallbackUserActivityPayload.method, "stream-notify-room");
    assert.deepEqual(fallbackUserActivityPayload.params, [
      "ROOM1/user-activity",
      "bot-test",
      ["user-typing"],
      {},
    ]);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          msg: "result",
          id: fallbackUserActivityPayload.id,
          result: { success: true },
        }),
      ),
    );
    await startTypingPromise;

    const stopTypingPromise = controls.sendTyping({
      roomId: "ROOM1",
      identities: ["Bot Test", "bot-test"],
      typing: false,
    });
    await nextTurn();

    const stopUserActivityPayload = JSON.parse(socket.sent.at(-1) ?? "{}") as {
      msg?: string;
      id?: string;
      method?: string;
      params?: unknown[];
    };
    assert.equal(stopUserActivityPayload.msg, "method");
    assert.equal(stopUserActivityPayload.method, "stream-notify-room");
    assert.deepEqual(stopUserActivityPayload.params, ["ROOM1/user-activity", "bot-test", [], {}]);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          msg: "result",
          id: stopUserActivityPayload.id,
          result: { success: true },
        }),
      ),
    );
    await stopTypingPromise;
  } finally {
    socket?.close();
    await connection;
  }
});

test("realtime connection subscribes to configured room ids", async () => {
  FakeWebSocket.instances.length = 0;
  let socket: FakeWebSocket | undefined;
  const readyTargets: string[] = [];

  const connection = createRealtimeConnection({
    baseUrl: "https://chat.example.com",
    authToken: "token-123",
    roomIds: ["ROOM1", "ROOM2", "ROOM1", " "],
    callbacks: {
      onMessage: () => {},
      onSubscriptionReady: (target) => {
        readyTargets.push(target);
      },
    },
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });

  try {
    socket = FakeWebSocket.instances[0];
    assert.ok(socket);

    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ msg: "connected" })));
    socket.emit("message", Buffer.from(JSON.stringify({ msg: "result", result: {} })));

    const subPayloads = socket.sent
      .map((entry) => JSON.parse(entry) as { msg?: string; id?: string; name?: string; params?: unknown[] })
      .filter((entry) => entry.msg === "sub");

    assert.deepEqual(
      subPayloads.map((entry) => entry.params?.[0]),
      ["__my_messages__", "ROOM1", "ROOM2"],
    );
    assert.ok(subPayloads.every((entry) => entry.name === "stream-room-messages"));

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ msg: "ready", subs: subPayloads.map((entry) => entry.id) })),
    );
    assert.deepEqual(readyTargets, ["__my_messages__", "ROOM1", "ROOM2"]);
  } finally {
    socket?.close();
    await connection;
  }
});

test("realtime connection dispatches direct room subscription events by message room id", async () => {
  FakeWebSocket.instances.length = 0;
  let socket: FakeWebSocket | undefined;
  const received: Array<{ roomId: string; messageId: string }> = [];

  const connection = createRealtimeConnection({
    baseUrl: "https://chat.example.com",
    authToken: "token-123",
    roomIds: ["ROOM1"],
    callbacks: {
      onMessage: (roomId, message) => {
        received.push({ roomId, messageId: message._id ?? "" });
      },
    },
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });

  try {
    socket = FakeWebSocket.instances[0];
    assert.ok(socket);

    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ msg: "connected" })));
    socket.emit("message", Buffer.from(JSON.stringify({ msg: "result", result: {} })));
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          msg: "changed",
          collection: "stream-room-messages",
          fields: {
            eventName: "ROOM1",
            args: [{ _id: "MSG1", rid: "ROOM1", msg: "hello", u: { _id: "USER1" } }],
          },
        }),
      ),
    );

    assert.deepEqual(received, [{ roomId: "ROOM1", messageId: "MSG1" }]);
  } finally {
    socket?.close();
    await connection;
  }
});
