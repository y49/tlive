# Telegram Setup Guide

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Telegram bot and wiring it into
tlive. The result is a bot you can DM (or add to a group) that delivers
status notifications — and, once you enable remote approval
(`tlive mode full`), approval cards you can answer from the chat.

**v2.0:** config is `~/.tlive/config.json`. The `tlive setup` wizard
writes it for you and registers the tlive plugin (hooks + skill + commands).

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

> The command-menu registration is handled automatically by tlive at boot
> via `setMyCommands`.

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

## Step 3 — (Optional) Allowed senders

By default tlive trusts anyone messaging from an allow-listed chat. To restrict
further by *user* (useful in group chats), collect user IDs:

1. Search for **@userinfobot** and send it any message.
2. It replies with your numeric Telegram user ID.
3. Add one `allowedSenders` entry per user (see Step 4).

> Recommended: always set at least one of `chatIdAllowList` (which chats) or
> `allowedSenders` (which users).

## Step 4 — Run `tlive setup`

```bash
tlive setup
```

When prompted for a channel, pick **Telegram** and paste:

- Bot token.
- Chat ID (the destination the bot sends to).

The wizard writes `~/.tlive/config.json` with a block like:

```json
{
  "adapters": {
    "telegram": {
      "token": "7823456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "chatIdAllowList": ["123456789"]
    }
  },
  "allowedSenders": [{ "channel": "telegram", "userId": "123456789" }]
}
```

You can edit the file by hand afterwards.

| Field | Type | Purpose |
|---|---|---|
| `adapters.telegram.token` | string | Bot token from BotFather. |
| `adapters.telegram.chatIdAllowList` | string[] | Chat IDs the bot sends to and accepts input from; inbound from any other chat is dropped (fail-closed). Negative IDs = groups/forums. |
| `allowedSenders` | `{channel, userId}[]` | Optional per-user hardening (Step 3). Empty ⇒ trust anyone in an allow-listed chat. |

Secure the file:

```bash
chmod 600 ~/.tlive/config.json
```

## Step 5 — Start + verify

```bash
tlive start
tlive status
```

In `tlive status` output, the Telegram probe calls `getMe` — a ✅ there
means the token is valid and tlive can reach the API. The `mode:` line shows
your posture (default `notify`).

Then confirm the round trip from the configured Telegram chat: DM the bot
`/help` and check it replies. To exercise **approval cards**, first turn on
remote approval (`tlive mode full`), then trigger a Claude tool call — in the
default `notify` mode no card is sent (tool prompts stay local).

---

## v2.0 platform notes

- **Transport.** Long-polling (no public URL, webhook, or TLS setup needed —
  the daemon connects outbound to Telegram).
- **Inline keyboards.** Used for approval-card buttons (Allow / Deny).
- **Inbound filtering.** The adapter accepts messages and button callbacks
  only from chats in `chatIdAllowList`. Any other chat is silently dropped
  (fail-closed).

---

## Troubleshooting

- **Bot responds in DM but not in groups.** Disable privacy via BotFather
  (`/setprivacy` → your bot → Disable), and make sure the group's ID is in
  `chatIdAllowList`.
- **"Unauthorized" at boot.** Token regenerated — copy the current one.
- **Empty `getUpdates` response.** Send a message to the bot first, then
  refresh.
- **Permission-card button clicks do nothing.** Remote approval is opt-in, and
  the default `notify` posture never holds an approval — so there is no card to
  answer. Switch with `tlive mode full`. If cards do appear but buttons don't
  land, check `tlive status` for a live daemon, then `tlive logs`.

Back to [Getting Started](getting-started.md) · [CLI command reference](commands.md).
