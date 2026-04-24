# Discord Setup Guide (v1.0)

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Discord bot and connecting it to
tlive v1.0. The result is a bot with registered slash commands, one thread
per session, and Discord's native Modal popup for elicitation forms.

**Changed in v1.0:** config moved to `~/.tlive/config.json` (JSON, not env
vars). Slash commands are registered dynamically via
`applications.{id}.commands.put` on daemon boot.

## What you'll need

- A Discord account.
- A server where you have admin permissions (free to create one).
- ~10 minutes.

## Step 1 — Create a Discord application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, name it (e.g. "tlive"), click **Create**.

## Step 2 — Create a bot user

1. In the left sidebar, click **Bot**.
2. Click **Reset Token** and confirm.
3. **Copy the token immediately** — you can't see it again (but you can reset).

Scroll to **Privileged Gateway Intents** and enable:

- **Message Content Intent** — required for the bot to read messages.

> Without Message Content Intent enabled, the bot connects but can't read
> anything. This is the most common misconfiguration.

### Required bot intents (spec §10.2)

| Intent | Why |
|---|---|
| Guild Messages | Receive messages in servers. |
| Message Content | Read the text content of messages. |
| Guild Message Reactions | Emit the 👁️ acknowledgement reaction. |
| Direct Messages | Support DMs to the bot. |

## Step 3 — Invite the bot

1. Left sidebar → **OAuth2** → **URL Generator**.
2. **Scopes**: check `bot` and `applications.commands`.
3. **Bot Permissions**: check
   - Send Messages
   - Read Message History
   - Manage Messages
   - Add Reactions
   - Create Public Threads
   - Send Messages in Threads
4. Copy the **Generated URL** at the bottom, open it, pick your server,
   authorise.

## Step 4 — Copy your IDs

Enable **Developer Mode**: User Settings → Advanced → Developer Mode = on.

- **User ID**: right-click your username → **Copy User ID**.
- **Channel ID** (optional): right-click a channel → **Copy Channel ID**.
  Restrict the bot to a specific channel.

## Step 5 — Run `tlive setup`

```bash
tlive setup
```

Pick **Discord** when prompted. Paste:

- Bot token.
- Allowed user IDs (comma-separated).
- (Optional) Allowed channel IDs.

The wizard writes `~/.tlive/config.json`:

```json
{
  "channels": {
    "discord": {
      "token": "MTIzNDU2Nzg5.Gh7x2A.xxxxx…",
      "allowedUsers": ["111111111"],
      "allowedChannels": ["333333333"]
    }
  }
}
```

Fields per spec §10.2:

| Field | Type | Purpose |
|---|---|---|
| `token` | string | Bot token from the Developer Portal. |
| `allowedUsers` | string[] | User ID whitelist. |
| `allowedChannels` | string[] | Channel ID whitelist (optional). |
| `registerSlashCommands` | boolean | Call `applications.commands.put` on boot (default `true`). |
| `proxy` | string | `http://` or `https://` only (SOCKS unsupported due to discord.js). |

Secure the file:

```bash
chmod 600 ~/.tlive/config.json
```

## Step 6 — Start + verify

```bash
tlive start
tlive doctor
```

The Discord probe logs into the gateway. Once the bot is online, tlive's
slash commands register automatically — type `/` in a channel where the
bot is present and you should see `/new`, `/sessions`, `/help`, etc.

Send a message mentioning or DMing the bot. You should see the 👁️
reaction, a new thread open (per-session), and a streamed reply.

---

## v1.0 platform requirements (spec §10.2)

- **Gateway + REST.** WebSocket for events, REST for send / edit / attach.
- **Slash command registration.** `applications.{id}.commands.put` on boot
  registers the 15 most-common commands. The remaining 30 still work when
  typed; they just don't appear in the autocomplete.
- **Thread-per-session.** `startThread` on the session header; all
  follow-up renders go into the thread. Keeps main channels clean.
- **Modal popups for elicitation.** Native `InteractionResponseType.Modal`
  with title + text-input fields, submitted back as a `ModalSubmit` event
  and aggregated.
- **Buttons + select menus.** Used for permission cards and
  multi-choice form fields.

## Proxy

```json
{
  "channels": {
    "discord": { "token": "…", "proxy": "http://127.0.0.1:7890" }
  }
}
```

Only `http://` / `https://` — SOCKS is not supported by the underlying
discord.js for the gateway connection. For SOCKS, use a system-level
transparent proxy (e.g. Clash TUN mode).

---

## Troubleshooting

- **Bot offline.** Token wrong, Message Content Intent not enabled, or
  `tlive status` says daemon not running.
- **Bot online, doesn't respond.** Nearly always Message Content Intent
  disabled. Re-toggle it.
- **"Missing Access" / "Missing Permissions".** Channel has override
  permissions that don't include the bot role. Check the channel's
  permission settings.
- **Slash commands don't autocomplete.** First boot takes a few minutes to
  propagate. Or `registerSlashCommands: false` was set.
- **Invalid token on startup.** Regenerate in Developer Portal and update
  `config.json`.

Back to [Getting Started](getting-started.md) · [IM command reference](commands.md).
