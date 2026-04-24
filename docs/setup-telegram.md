# Telegram Setup Guide (v1.0)

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Telegram bot and wiring it into
tlive v1.0. The result is a bot you can DM (or add to a group / forum
group) from which the full 45-command IM surface is available.

**Changed in v1.0:** config is `~/.tlive/config.json` (not `config.env`),
and the `tlive setup` wizard writes it for you. The hand-written env-var
approach still exists, but the wizard is canonical.

## What you'll need

- A Telegram account.
- ~5 minutes.
- (Optional, for topic-per-session UX) a **forum group** where your bot is
  admin.

## Step 1 — Create a bot with @BotFather

1. Open Telegram, search for **@BotFather**, send `/newbot`.
2. Choose a **display name** (e.g. "My tlive bot").
3. Choose a **username** — must end in `bot` (e.g. `my_tlive_bot`).
4. BotFather replies with a **bot token** like
   `7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
5. Copy the full token. Keep it secret.

Recommended BotFather settings:

| `/setprivacy` | Disable | Lets the bot read group messages (needed for group / forum use). |

> The `/setcommands` registration is handled automatically by tlive at boot
> via `setMyCommands` (see spec §10.1 `bot-commands.ts`).

## Step 2 — Find your chat ID

Needed so tlive knows which chat to bind to.

1. In Telegram, start a chat with your bot and tap **Start**.
2. Send any message (e.g. `hello`).
3. Open in a browser (replacing `YOUR_TOKEN`):
   ```text
   https://api.telegram.org/botYOUR_TOKEN/getUpdates
   ```
4. In the JSON, find `"chat":{"id":123456789,...}` — that's your chat ID.
5. **Group/forum chats** have negative IDs like `-1001234567890`.

## Step 3 — (Optional) Allowed user IDs

If you don't want anyone who finds the bot to use it, restrict by user.

1. Search for **@userinfobot** and send it any message.
2. It replies with your numeric Telegram user ID.
3. Collect IDs for every allowed user.

> Recommended: always set at least one of `chatId` or `allowedUsers`.

## Step 4 — Run `tlive setup`

```bash
tlive setup
```

When prompted for a channel, pick **Telegram** and paste:

- Bot token.
- Chat ID (or leave blank to allow any chat that an allowed user DMs from).
- Allowed user IDs (comma-separated).

The wizard writes `~/.tlive/config.json` with a block like:

```json
{
  "channels": {
    "telegram": {
      "token": "7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "chatId": "123456789",
      "allowedUsers": ["123456789"],
      "requireMention": true
    }
  }
}
```

You can edit the file by hand afterwards. Fields per spec §10.1:

| Field | Type | Purpose |
|---|---|---|
| `token` | string | Bot token from BotFather. |
| `chatId` | string \| string[] | Restrict to specific chat(s). Negative IDs = groups. |
| `allowedUsers` | string[] | Whitelist of user IDs. |
| `requireMention` | boolean | In groups, only respond when @mentioned (default `true`). |
| `webhook` | object | See "Webhook mode" below. Omit for long-polling. |
| `proxy` | string | `http://`, `https://`, `socks4://`, `socks5://`. |

Secure the file:

```bash
chmod 600 ~/.tlive/config.json
```

## Step 5 — Start + verify

```bash
tlive start
tlive doctor
```

In doctor output, the Telegram probe calls `getMe` — a ✅ there means the
token is valid and tlive can reach the API.

Then in Telegram: DM the bot `hello`. You should see the 👁️ reaction, a
pinned session header, and a streamed reply.

---

## v1.0 platform requirements (spec §10.1)

- **Transport.** Long-polling by default; webhook optional.
- **MarkdownV2 escaping.** `src/platform/telegram/renderer.ts` escapes
  special characters (`_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`,
  `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`). You generally don't
  care unless you're writing a plugin; just know that agent output
  containing `_foo_` won't italicise accidentally.
- **Forum groups (optional, recommended for topic-per-session).** In a
  Telegram forum group where the bot is admin, each session opens its own
  topic. Disable the forum feature to route all sessions into the main
  thread.
- **Emoji reactions.** Supported for `👁️` acknowledgement via
  `setMessageReaction` when the bot has reaction permission.
- **Inline keyboards.** Used for permission-card buttons (Allow / Deny /
  Always / Learn).
- **forceReply.** Used for elicitation form rendering — one question per
  bot message, answers aggregated.

## Webhook mode (optional)

For production, avoid long-polling overhead:

```json
{
  "channels": {
    "telegram": {
      "token": "…",
      "webhook": {
        "url": "https://your-domain.com/telegram-webhook",
        "secret": "random-hex-string",
        "port": 8443
      }
    }
  }
}
```

The daemon exposes the webhook endpoint on the given port. TLS
termination is on you (nginx / Caddy / fly.io proxy).

## Proxy

```json
{
  "channels": {
    "telegram": { "token": "…", "proxy": "socks5://127.0.0.1:1080" }
  }
}
```

Supported: `http://`, `https://`, `socks4://`, `socks5://`.

---

## Troubleshooting

- **Bot responds in DM but not in groups.** Disable privacy via BotFather
  (`/setprivacy` → your bot → Disable). If `requireMention: true` you must
  `@yourbot <message>`.
- **"Unauthorized" at boot.** Token regenerated — copy the current one.
- **Empty `getUpdates` response.** Send a message to the bot first, then
  refresh.
- **Permission-card button clicks do nothing.** See
  [references/troubleshooting.md](../references/troubleshooting.md)
  ("Permission card buttons not working").

Back to [Getting Started](getting-started.md) · [IM command reference](commands.md).
