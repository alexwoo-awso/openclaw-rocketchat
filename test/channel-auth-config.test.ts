import test from "node:test";
import assert from "node:assert/strict";
import {
  isRocketChatAccountConfigured,
  listRocketChatAccountIds,
  resolveDefaultRocketChatAccountId,
  resolveRocketChatAccount,
} from "../src/rocketchat/accounts.js";
import { loginWithPassword } from "../src/rocketchat/client.js";
import { probeRocketChat } from "../src/rocketchat/probe.js";

test("username/password account is treated as configured", () => {
  const cfg = {
    channels: {
      rocketchat: {
        accounts: {
          default: {
            baseUrl: "https://chat.example.com",
            username: "bot-test",
            password: "secret",
            enabled: true,
          },
        },
      },
    },
  };

  const account = resolveRocketChatAccount({ cfg });

  assert.equal(account.usesLoginAuth, true);
  assert.equal(isRocketChatAccountConfigured(account), true);
  assert.deepEqual(listRocketChatAccountIds(cfg), ["default"]);
  assert.equal(resolveDefaultRocketChatAccountId(cfg), "default");
});

test("login auth is not treated as configured without a base URL", () => {
  const account = resolveRocketChatAccount({
    cfg: {
      channels: {
        rocketchat: {
          accounts: {
            default: {
              username: "bot-test",
              password: "secret",
              enabled: true,
            },
          },
        },
      },
    },
  });

  assert.equal(account.usesLoginAuth, true);
  assert.equal(isRocketChatAccountConfigured(account), false);
});

test("loginWithPassword and probeRocketChat support username/password auth flow", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://chat.example.com/api/v1/login") {
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          status: "success",
          data: { authToken: "token-123", userId: "user-123" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url === "https://chat.example.com/api/v1/me") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-Auth-Token"), "token-123");
      assert.equal(headers.get("X-User-Id"), "user-123");
      return new Response(
        JSON.stringify({
          _id: "user-123",
          username: "bot-test",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const login = await loginWithPassword({
      baseUrl: "https://chat.example.com",
      username: "bot-test",
      password: "secret",
    });
    assert.deepEqual(login, { authToken: "token-123", userId: "user-123" });

    const probe = await probeRocketChat(
      "https://chat.example.com",
      login.authToken,
      login.userId,
      2500,
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.bot?._id, "user-123");
    assert.equal(probe.bot?.username, "bot-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loginWithPassword retries once when Rocket.Chat returns 429 with a wait window", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (input: URL | string) => {
    const url = String(input);
    if (url !== "https://chat-rate-limit.example.com/api/v1/login") {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    attempts += 1;
    if (attempts === 1) {
      return new Response(
        JSON.stringify({
          error:
            "Error, too many requests. Please slow down. You must wait 0 seconds before trying this endpoint again. [error-too-many-requests]",
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        status: "success",
        data: { authToken: "token-429", userId: "user-429" },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const login = await loginWithPassword({
      baseUrl: "https://chat-rate-limit.example.com",
      username: "bot-rate-limit",
      password: "secret",
    });
    assert.deepEqual(login, { authToken: "token-429", userId: "user-429" });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loginWithPassword reuses cached sessions until forced refresh", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (input: URL | string) => {
    const url = String(input);
    if (url !== "https://chat-cache.example.com/api/v1/login") {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    attempts += 1;
    return new Response(
      JSON.stringify({
        status: "success",
        data: { authToken: `token-${attempts}`, userId: `user-${attempts}` },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const first = await loginWithPassword({
      baseUrl: "https://chat-cache.example.com",
      username: "bot-cache",
      password: "secret",
    });
    const second = await loginWithPassword({
      baseUrl: "https://chat-cache.example.com",
      username: "bot-cache",
      password: "secret",
    });
    const refreshed = await loginWithPassword({
      baseUrl: "https://chat-cache.example.com",
      username: "bot-cache",
      password: "secret",
      forceRefresh: true,
    });

    assert.deepEqual(first, { authToken: "token-1", userId: "user-1" });
    assert.deepEqual(second, first);
    assert.deepEqual(refreshed, { authToken: "token-2", userId: "user-2" });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
