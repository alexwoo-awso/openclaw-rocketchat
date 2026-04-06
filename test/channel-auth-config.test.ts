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
