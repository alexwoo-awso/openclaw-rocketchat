# OpenClaw Rocket.Chat Plugin

Channel plugin for connecting OpenClaw to [Rocket.Chat](https://rocket.chat/) instances.

**npm package:** `@alexwoo-awso/openclaw-rocketchat`

## Features

- Direct messages, channels, groups, and thread support
- Media/file upload and download
- Mention detection and configurable chat modes
- Multi-account support
- Pairing-based access control
- Block streaming with coalescing
- WebSocket (DDP) realtime message monitoring with auto-reconnect

## Setup

### Secret storage (recommended)

Prefer environment variables for secrets (token/password) rather than committing them into `openclaw.json`.

OpenClaw loads env vars from:
- the Gateway process environment (systemd/launchd/etc), and
- `~/.openclaw/.env` as a standard global fallback.

See: OpenClaw docs “Environment variables”.

### 1. Authentication

The plugin supports two authentication methods:

#### Method A: Personal Access Token (recommended for plans that support it)

1. Go to **My Account → Personal Access Tokens** in your Rocket.Chat instance
2. Create a new token — note both the **Token** and your **User ID**

> **Note:** Personal Access Tokens may not be available on all Rocket.Chat plans (e.g., Starter).

#### Method B: Username/Password Login (works on all plans)

If PAT is not available, use username/password. The plugin will call `/api/v1/login` to obtain a session token automatically.

### 2. Configure OpenClaw

#### Environment variables (default account)

Set these on the gateway host (for systemd/launchd installs you can put them in `~/.openclaw/.env`):

- `ROCKETCHAT_URL=https://chat.example.com`
- `ROCKETCHAT_AUTH_TOKEN=...`
- `ROCKETCHAT_USER_ID=...`

If you use login auth instead of a Personal Access Token:

- `ROCKETCHAT_USERNAME=...`
- `ROCKETCHAT_PASSWORD=...`

Env vars apply only to the **default** account. Other accounts must use config values under `channels.rocketchat.accounts`.

#### Option A: Environment Variables (PAT)

```bash
export ROCKETCHAT_URL=https://chat.example.com
export ROCKETCHAT_AUTH_TOKEN=your-personal-access-token
export ROCKETCHAT_USER_ID=your-user-id
```

#### Option B: Environment Variables (Username/Password)

```bash
export ROCKETCHAT_URL=https://chat.example.com
export ROCKETCHAT_USERNAME=openclaw
export ROCKETCHAT_PASSWORD=your-password
```

#### Option C: Config File (PAT)

```json
{
  "channels": {
    "rocketchat": {
      "enabled": true,
      "baseUrl": "https://chat.example.com",
      "authToken": "your-personal-access-token",
      "userId": "your-user-id",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

#### Option D: Config File (Username/Password)

```json
{
  "channels": {
    "rocketchat": {
      "enabled": true,
      "baseUrl": "https://chat.example.com",
      "username": "openclaw",
      "password": "your-password",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

### 3. Multi-Account Setup

```yaml
channels:
  rocketchat:
    enabled: true
    accounts:
      primary:
        baseUrl: https://chat.example.com
        authToken: token1
        userId: uid1
        allowFrom: ["@admin"]
      secondary:
        baseUrl: https://other-server.com
        authToken: token2
        userId: uid2
        allowFrom: ["@user"]
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | string | — | Rocket.Chat server URL |
| `authToken` | string | — | Personal access token |
| `userId` | string | — | Bot user's ID |
| `username` | string | — | Username for login auth (alternative to PAT) |
| `password` | string | — | Password for login auth (alternative to PAT) |
| `dmPolicy` | string | `"pairing"` | `pairing`, `allowlist`, `open`, `disabled` |
| `allowFrom` | array | `[]` | Allowed user IDs or @usernames for DMs |
| `groupPolicy` | string | `"allowlist"` | `allowlist`, `open`, `disabled` |
| `groupAllowFrom` | array | `[]` | Allowed senders in groups/channels |
| `chatmode` | string | — | `oncall`, `onmessage`, `onchar` |
| `requireMention` | boolean | `true` | Require @mention in channels |
| `textChunkLimit` | number | `4000` | Max chars per outbound message |
| `blockStreaming` | boolean | — | Enable/disable block streaming |

## Sending Messages

```bash
# Send to a channel
openclaw send --channel rocketchat --to channel:ROOM_ID "Hello!"

# Send to a user
openclaw send --channel rocketchat --to @username "Hello!"
openclaw send --channel rocketchat --to user:USER_ID "Hello!"
```

## Architecture

- **DDP WebSocket** for realtime message reception (stream-room-messages)
- **REST API** for sending messages, file uploads, user/room info
- Authentication via `X-Auth-Token` + `X-User-Id` headers
- Room types: `c` (channel), `p` (private group), `d` (direct), `l` (livechat)

## Troubleshooting

- No replies in channels: ensure the bot is in the channel and mention it (oncall), use a trigger prefix (onchar), or set `chatmode: "onmessage"`.
- Auth/token issues:
  - **Preferred (recommended):** use a Rocket.Chat **Personal Access Token (PAT)** (`ROCKETCHAT_AUTH_TOKEN` + `ROCKETCHAT_USER_ID`). PATs are typically long-lived until revoked.
  - **Alternative:** configure `ROCKETCHAT_USERNAME` + `ROCKETCHAT_PASSWORD`. The plugin logs in via `/api/v1/login` and will re-login automatically if the session token expires.
  - If you manually generated a login session token and pasted it into config without also providing username/password, that token may expire based on your Rocket.Chat server settings (often ~90 days). In that case prefer PAT or store username/password so the plugin can refresh automatically.
- Multi-account issues: env vars only apply to the `default` account.

## License

MIT
