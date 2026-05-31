# OpenClaw Rocket.Chat Plugin

Channel plugin for connecting OpenClaw to [Rocket.Chat](https://rocket.chat/) instances.

**npm package:** `@alexwoo-awso/openclaw-rocketchat`

## Features

- Direct messages, channels, private groups, and threads
- Media/file upload and download
- Mention-gated channel behavior, `onmessage`, and `onchar` trigger modes
- Conversation windows for follow-up messages after a mention or trigger
- Multi-account support
- Pairing-based DM access control
- Block streaming with configurable coalescing
- DDP WebSocket realtime monitoring with auto-reconnect

## Setup

### Authentication methods

The plugin supports both Rocket.Chat auth paths:

- **Personal Access Token (PAT):** configure `authToken` + `userId`
- **Username/password login:** configure `username` + `password`

PAT is usually the better choice when your Rocket.Chat plan exposes Personal Access Tokens. Username/password works on plans where PAT is unavailable.

### Secret storage

Prefer environment variables for secrets instead of committing them into `openclaw.json`.

OpenClaw can load env vars from:

- the gateway process environment
- `~/.openclaw/.env`

### Base URL

Use the Rocket.Chat server base URL, for example:

- `https://chat.example.com`

Do not use `/api/v1` in config examples unless you want to; the plugin strips a trailing slash and also normalizes a trailing `/api/v1`.

### Important config rules

- The bot user must already be a member of channels or private groups you want it to monitor.
- Only the **default** Rocket.Chat account can read `ROCKETCHAT_*` environment variables.
- Config values override env vars **field by field**.
- If you define `channels.rocketchat.accounts`, the top-level `channels.rocketchat` values still act as shared defaults for those named accounts unless a per-account value overrides them.
- A Rocket.Chat account is considered configured when it has `baseUrl` plus either `authToken` + `userId` or `username` + `password`.

### Option A: Default account from environment variables

PAT:

```bash
export ROCKETCHAT_URL=https://chat.example.com
export ROCKETCHAT_AUTH_TOKEN=your-personal-access-token
export ROCKETCHAT_USER_ID=your-user-id
```

Username/password:

```bash
export ROCKETCHAT_URL=https://chat.example.com
export ROCKETCHAT_USERNAME=openclaw-bot
export ROCKETCHAT_PASSWORD=your-password
```

### Option B: Default account in `openclaw.json`

PAT:

```json
{
  "channels": {
    "rocketchat": {
      "enabled": true,
      "baseUrl": "https://chat.example.com",
      "authToken": "your-personal-access-token",
      "userId": "your-user-id"
    }
  }
}
```

Username/password:

```json
{
  "channels": {
    "rocketchat": {
      "enabled": true,
      "baseUrl": "https://chat.example.com",
      "username": "openclaw-bot",
      "password": "your-password"
    }
  }
}
```

### Option C: Multi-account config

Named accounts are config-only. `ROCKETCHAT_*` env vars do not apply to them.

This example also shows shared top-level defaults inherited by each account:

```yaml
channels:
  rocketchat:
    enabled: true
    chatmode: oncall
    conversationWindowMinutes: 10
    groupPolicy: allowlist
    accounts:
      primary:
        baseUrl: https://chat.example.com
        authToken: token-1
        userId: user-1
        allowFrom: ["@admin"]
      secondary:
        baseUrl: https://other-chat.example.com
        username: openclaw-bot
        password: secret
        chatmode: onchar
        oncharPrefixes: ["!"]
        rooms:
          GENERAL_ROOM_ID:
            conversationWindowMinutes: 20
```

## Configuration Reference

The same account-level options can be set either:

- at `channels.rocketchat.*` for the default/shared config
- at `channels.rocketchat.accounts.<accountId>.*` for a named account

### Authentication and connection

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Enables or disables the channel or account. Default is enabled. |
| `name` | string | Optional display name for the account in CLI/UI lists. |
| `baseUrl` | string | Rocket.Chat base URL such as `https://chat.example.com`. |
| `authToken` | string | Personal Access Token. |
| `userId` | string | Rocket.Chat user ID paired with `authToken`. |
| `username` | string | Username for login auth instead of PAT. |
| `password` | string | Password for login auth instead of PAT. |

### Inbound trigger behavior

| Option | Type | Description |
|--------|------|-------------|
| `chatmode` | string | `oncall`, `onmessage`, or `onchar`. |
| `oncharPrefixes` | string[] | Prefixes that trigger `chatmode: onchar`. Default: `">"` and `"!"`. |
| `requireMention` | boolean | Mention gate for groups/channels when `chatmode` does not force behavior. |
| `conversationWindowMinutes` | number | Keeps a room active for follow-up messages after a valid mention/trigger. `0` or unset disables it. |
| `rooms.<roomId>.conversationWindowMinutes` | number | Per-room override for the conversation window. |

Behavior notes:

- Direct messages are not mention-gated.
- `chatmode: oncall` effectively requires a mention in channels/groups.
- `chatmode: onmessage` effectively disables mention gating in channels/groups.
- `chatmode: onchar` accepts channel/group messages that start with a configured prefix, and strips that prefix before sending the message to OpenClaw.
- Conversation windows only relax the mention/trigger requirement; they do not bypass access-control policy.

### Access control

| Option | Type | Description |
|--------|------|-------------|
| `dmPolicy` | string | DM policy: `pairing`, `allowlist`, `open`, or `disabled`. Default: `pairing`. |
| `allowFrom` | array | Allowed DM senders as Rocket.Chat user IDs, `user:ID`, `rocketchat:ID`, plain usernames, or `@username`. |
| `groupPolicy` | string | Group/channel policy: `allowlist`, `open`, or `disabled`. Default: `allowlist`. |
| `groupAllowFrom` | array | Allowed senders in channels/private groups. |

Important:

- If `dmPolicy` is `open`, `allowFrom` must include `"*"` or schema validation fails.
- `allowFrom` and `groupAllowFrom` comparisons are case-insensitive for usernames.

### Outbound reply behavior

| Option | Type | Description |
|--------|------|-------------|
| `textChunkLimit` | number | Maximum characters per outbound text message. Default: `4000`. |
| `chunkMode` | string | Outbound chunking mode: `length` or `newline`. |
| `blockStreaming` | boolean | Enables or disables block streaming for this channel/account. |
| `blockStreamingCoalesce.minChars` | number | Minimum buffered characters before a streamed block reply is flushed. |
| `blockStreamingCoalesce.idleMs` | number | Idle timeout before a buffered streamed block reply is flushed. |
| `responsePrefix` | string | Optional outbound reply prefix override for this channel/account. |
| `markdown` | object | Standard OpenClaw markdown configuration for this channel/account. |

Current streaming defaults for Rocket.Chat:

- `blockStreamingCoalesce.minChars`: `1500`
- `blockStreamingCoalesce.idleMs`: `1000`

Delivery notes:

- Long text replies are split into sequential Rocket.Chat messages.
- `chunkMode: newline` splits more aggressively than `chunkMode: length`.
- If media upload fails and the media source was an `http://` or `https://` URL, the plugin falls back to sending the URL as text.

### Miscellaneous

| Option | Type | Description |
|--------|------|-------------|
| `configWrites` | boolean | Allows channel-initiated config writes. |
| `capabilities` | string[] | Optional capability tags used for agent/runtime guidance. |

## Sending Messages

```bash
# Send to a room id directly
openclaw send --channel rocketchat --to ROOM_ID "Hello"

# Send to a room id with an explicit prefix
openclaw send --channel rocketchat --to channel:ROOM_ID "Hello"

# Send to a user
openclaw send --channel rocketchat --to @username "Hello"
openclaw send --channel rocketchat --to user:USER_ID "Hello"
```

Accepted `--to` formats:

- `ROOM_ID`
- `channel:ROOM_ID`
- `@username`
- `user:USER_ID`
- `rocketchat:USER_ID`

When sending to a user, the plugin creates or reuses a Rocket.Chat DM room for that user.

## TweetClaw X/Twitter companion workflow

Teams that coordinate social support, growth, or incident response from Rocket.Chat can pair this channel with [TweetClaw](https://github.com/Xquik-dev/tweetclaw) as a separate OpenClaw plugin.

This repository stays responsible for Rocket.Chat transport: DMs, channels, private groups, threads, file handling, and room access control. TweetClaw is an optional third-party plugin for X/Twitter work such as search tweets, search tweet replies, follower export, user lookup, media workflows, monitor tweets, webhooks, giveaway draws, and approval-reviewed post tweets or post tweet replies.

Install both plugins:

```bash
openclaw plugins install @alexwoo-awso/openclaw-rocketchat
openclaw plugins install @xquik/tweetclaw@1.6.31
openclaw plugins inspect tweetclaw --runtime
```

Allow TweetClaw tools alongside your normal OpenClaw tools:

```json
{
  "tools": {
    "alsoAllow": ["explore", "tweetclaw"]
  }
}
```

If `tools.alsoAllow` already contains other tools, append `explore` and `tweetclaw` to the existing list instead of replacing it.

Keep the two configs separate:

- `channels.rocketchat.*` holds Rocket.Chat server, room, and bot credentials.
- TweetClaw uses its own Xquik API key, credit, or MPP configuration.
- Do not put Xquik keys or TweetClaw billing settings in `channels.rocketchat`.
- Keep `dmPolicy`, `allowFrom`, `groupPolicy`, and `groupAllowFrom` tight for rooms that can request social actions.

Suggested room workflow:

```text
User in #growth: !search tweets about OpenClaw release feedback
Agent: uses TweetClaw to search tweets and replies, then summarizes results in the Rocket.Chat thread

User: draft a reply to this tweet
Agent: prepares the TweetClaw post tweet reply call and waits for explicit approval before sending
```

For write-like, paid, private, bulk, or recurring work, review the structured TweetClaw request before approving the tool call. This includes post tweets, post tweet replies, direct messages, media upload, monitor tweets, webhooks, profile changes, and giveaway draws.

## GetXAPI X/Twitter companion workflow

Teams that prefer an HTTP-only Twitter/X data backend can pair this channel with [GetXAPI](https://github.com/getxapi/getxapi-mcp) as an alternative companion alongside the TweetClaw recipe above.

This repository stays responsible for Rocket.Chat transport. GetXAPI exposes read-only tweet, user, and search endpoints through a single REST surface, which keeps the Rocket.Chat plugin focused on chat transport while a separate process handles X/Twitter reads.

Install this plugin and configure a GetXAPI key alongside it:

```bash
openclaw plugins install @alexwoo-awso/openclaw-rocketchat
export GETXAPI_API_KEY=...
```

Suggested env layout for the agent process that calls GetXAPI:

```bash
GETXAPI_API_KEY=...
GETXAPI_ENABLE_ACTIONS=false
```

`GETXAPI_ENABLE_ACTIONS` stays `false` by default so the backend is read-only. Flip it to `true` only after reviewing the action surface, the same way you would gate TweetClaw write tools.

Keep the two configs separate:

- `channels.rocketchat.*` holds Rocket.Chat server, room, and bot credentials.
- GetXAPI uses its own `GETXAPI_API_KEY` environment variable.
- Do not put GetXAPI keys in `channels.rocketchat`.
- Keep `dmPolicy`, `allowFrom`, `groupPolicy`, and `groupAllowFrom` tight for rooms that can request social actions.

Suggested room workflow:

```text
User in #growth: !search tweets about OpenClaw release feedback
Agent: calls GetXAPI advanced_search, summarizes results in the Rocket.Chat thread

User: pull the latest tweets from @some_user
Agent: calls GetXAPI user timeline endpoint, posts the digest into the thread
```

GetXAPI endpoint reference:

- `GET https://api.getxapi.com/twitter/tweet/advanced_search?q=<query>`
- Header: `Authorization: Bearer ${GETXAPI_API_KEY}`

## Architecture

- DDP WebSocket for realtime inbound messages
- Rocket.Chat REST API for login, sending messages, uploads, user lookup, and room lookup
- Threads are sent with Rocket.Chat `tmid`
- Room types handled: channels (`c`), private groups (`p`), direct messages (`d`), and livechat (`l`)

## Troubleshooting

- No replies in channels:
  - make sure the bot user is in the room
  - `chatmode: oncall` requires a mention unless a conversation window is active
  - `chatmode: onchar` requires a configured prefix such as `!hello`
  - `chatmode: onmessage` replies to accepted channel/group messages without a mention
- Auth problems:
  - PAT mode needs both `authToken` and `userId`
  - login mode needs both `username` and `password`
  - the plugin logs in through `/api/v1/login` when using username/password and can log in again later if needed
  - env vars only apply to the default account
- Base URL problems:
  - use the server base URL, not a deep REST path
  - trailing `/` and `/api/v1` are normalized away

Security review notes for scanner findings and manual audits are tracked in `SECURITY.md`.

## License

MIT
