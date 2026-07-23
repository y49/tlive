# Feishu / Lark Setup Guide

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Feishu (or Lark) custom app and
wiring it into tlive. Feishu's setup has more steps than other platforms —
you create an app, add permissions, subscribe to events, publish a version,
and get workspace-admin approval. Once done, the bot delivers status
notifications — and, once you enable remote approval (`tlive mode full`),
approval cards you can answer from the chat.

**v2.0:** config is `~/.tlive/config.json` (JSON). `tlive setup` is the
recommended way to populate the `adapters.feishu` block and register the
tlive plugin.

## What you'll need

- A Feishu account (or Lark for the international edition).
- Admin permission to create / approve custom apps (or an admin who can
  approve).
- ~15 minutes.

## Step 1 — Create a custom app

1. Go to the developer console:
   - **Feishu (China):** https://open.feishu.cn/app
   - **Lark (International):** https://open.larksuite.com/app
2. Sign in.
3. Click **Create Custom App**.
4. Fill in:
   - **App Name** — e.g. "tlive".
   - **Description** — e.g. "tlive daemon bridge".
5. Click **Create**.

## Step 2 — Grab credentials

1. On the app page, go to **Credentials & Basic Info**.
2. Copy:
   - **App ID** — starts with `cli_`.
   - **App Secret** — long alphanumeric string.

Keep the secret private.

## Step 3 — Add permissions (batch import)

In **Permissions & Scopes**, click **Batch import** and paste:

```json
{
  "scopes": {
    "tenant": [
      "cardkit:card:read",
      "cardkit:card:write",
      "im:chat:readonly",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ]
  }
}
```

### Permission rationale

| Scope | Why |
|---|---|
| `im:message`, `im:message:send_as_bot` | Send bot replies. |
| `im:message:readonly`, `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly` | Read incoming messages. |
| `im:chat:readonly` | Resolve chat metadata for session binding. |
| `cardkit:card:read`, `cardkit:card:write` | Interactive cards (permission cards, session header, activity sticky, form cards). |
| `im:resource` | Upload / download attachments (inbound images from user, outbound files produced by Claude). |

All are required for the full UX. Missing `cardkit:card:write` disables
edit-in-place for stickies and falls back to append-only rendering.

## Step 4 — Configure events (WebSocket)

In **Events & Callbacks**:

1. Under **Event Subscriptions**, click **Add Event** and add:
   - `im.message.receive_v1` — incoming messages.
   - `card.action.trigger` — button clicks on interactive cards.
2. Under **Callback Mode**, choose **Long Connection (WebSocket)**.
   Do **not** choose HTTP callback; tlive uses WebSocket so you don't
   need a public URL.

> WebSocket (Long Connection) is the only supported transport — the daemon
> pushes outbound from your machine, so no firewall or TLS setup required.

## Step 5 — Publish & get admin approval

1. Left sidebar → **App Release** (or **Version Management**).
2. **Create Version**:
   - **Version**: `1.0.0`.
   - **Release notes**: any short description.
   - **Availability**: choose users/departments or "All employees".
3. **Submit for Review**.
4. A workspace admin approves the app:
   - Feishu: https://feishu.cn/admin
   - Lark: https://larksuite.com/admin
   - Find your app in **App Review** or **Workspace Apps**, click **Approve**.

If you're your own admin, approve immediately.

## Step 6 — Run `tlive setup`

```bash
tlive setup
```

Pick **Feishu** when prompted. Paste:

- App ID.
- App Secret.
- Chat ID — the `open_chat_id` (`oc_…`) of the chat the bot posts to.

The wizard writes `~/.tlive/config.json`:

```json
{
  "adapters": {
    "feishu": {
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "…",
      "chatId": "oc_xxxxxxxxxxxxxxxx"
    }
  },
  "allowedSenders": [{ "channel": "feishu", "userId": "ou_xxxxxxxxxxxxxxxx" }]
}
```

| Field | Type | Purpose |
|---|---|---|
| `adapters.feishu.appId` | string | From the developer console. |
| `adapters.feishu.appSecret` | string | From the developer console. |
| `adapters.feishu.chatId` | string | The chat the bot posts to — its `open_chat_id` (starts `oc_`). **Required to send.** |
| `allowedSenders` | `{channel, userId}[]` | Optional per-user hardening — Open IDs (`ou_…`). Empty ⇒ trust the configured chat. |

`chatId` is **required to send**. If you don't have it yet, leave that prompt
blank and add it later — find it from the group's info, or from the inbound
event once the bot receives your first message (Step 7) — then re-run
`tlive setup` (or edit the file) to fill it in.

Secure the file:

```bash
chmod 600 ~/.tlive/config.json
```

## Step 7 — Start + verify

```bash
tlive start
tlive status
```

The Feishu probe calls
`auth/v3/tenant_access_token/internal`. Code `0` = credentials valid. The
`mode:` line shows your posture (default `notify`).

Open Feishu, search for the app name — the bot should appear under
**Bots** / **Apps**. DM it `/help` and check it replies. To exercise
**approval cards**, first turn on remote approval (`tlive mode full`), then
trigger a Claude tool call — in the default `notify` mode no card is sent
(tool prompts stay local).

---

## v2.0 platform notes

- **Event transport.** WebSocket (long connection) only. No public URL
  required — the daemon connects outbound to Feishu.
- **Interactive card markup.** Approval cards use Feishu Card schema v2
  with callback button behaviors.
- **Inbound filtering.** The adapter accepts messages and card button
  callbacks only from the configured `chatId`. Any other chat is silently
  dropped (fail-closed).

## Lark (international)

The developer / admin portals differ:

- Developer portal: https://open.larksuite.com/app
- Admin console: https://larksuite.com/admin

Scopes, event names, API shapes, and the tlive config (`appId` / `appSecret` /
`chatId`) are all the same. Note tlive does **not** currently expose a
Feishu-vs-Lark endpoint switch (no `lark`/`domain` config field) — it uses the
`@larksuiteoapi/node-sdk` default. If you're on Lark international and it does
not connect, open an issue.

---

## Troubleshooting

- **"App not approved" / bot doesn't appear in Feishu.** You haven't
  published a version, or the admin hasn't approved it.
- **No events received.** You chose HTTP callback instead of
  Long Connection — switch it.
- **"Permission denied" errors.** A scope was added after the last
  release — create a new version and get it re-approved.
- **"Invalid App ID" / "Invalid App Secret".** Typos, or you copied from
  the wrong app.
- **Bot replies in Feishu but nothing in tlive logs.** `adapters.feishu`
  missing from `config.json`, or `tlive start` wasn't run after config
  edit.

Back to [Getting Started](getting-started.md) · [CLI command reference](commands.md).
