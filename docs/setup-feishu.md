# Feishu / Lark Setup Guide

[Back to Getting Started](getting-started.md)

This guide walks you through creating a Feishu (or Lark) custom app and
wiring it into tlive. Feishu's setup has more steps than other platforms —
you create an app, add permissions, subscribe to events, publish a version,
and get workspace-admin approval. Once done, the bot delivers approval cards
and status notifications from Claude Code.

**v2.0:** config is `~/.tlive/config.json` (JSON). `tlive setup` is the
recommended way to populate the `channels.feishu` block and install hooks.

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

### v1.0 permission rationale (spec §10.3)

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

> WebSocket mode is the only supported transport in v1.0 — the daemon
> pushes outbound from your machine, so no firewall or TLS setup
> required.

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
- (Optional) Allowed user Open IDs (`ou_…`).

The wizard writes `~/.tlive/config.json`:

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "…",
      "allowedUsers": ["ou_xxxxxxxxxxxxxxxx"],
      "lark": false
    }
  }
}
```

Fields per spec §10.3:

| Field | Type | Purpose |
|---|---|---|
| `appId` | string | From developer console. |
| `appSecret` | string | From developer console. |
| `lark` | boolean | `true` to use `open.larksuite.com` endpoints. |
| `allowedUsers` | string[] | Open ID whitelist (optional). |
| `topicPerSession` | boolean | Use new-style group topics as session threads (default `true` when supported). |

Secure the file:

```bash
chmod 600 ~/.tlive/config.json
```

> **Note:** `allowedUsers` and `topicPerSession` are accepted in the
> documentation block above for forward-compatibility, but as of v1.0
> only `appId`, `appSecret`, and `lark` are read by the daemon. Use
> `lark: true` for the international Lark edition (open.larksuite.com).

## Step 7 — Start + verify

```bash
tlive start
tlive status
```

The Feishu probe calls
`auth/v3/tenant_access_token/internal`. Code `0` = credentials valid.

Open Feishu, search for the app name — the bot should appear under
**Bots** / **Apps**. DM it or send a message in the configured chat, then
trigger a Claude tool call to see the approval card.

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

Everything is identical except:

- Developer portal: https://open.larksuite.com/app
- Admin console: https://larksuite.com/admin
- Set `lark: true` in the config block.

All scopes, event names, and API shapes are the same.

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
- **Bot replies in Feishu but nothing in tlive logs.** `channels.feishu`
  missing from `config.json`, or `tlive start` wasn't run after config
  edit.

Back to [Getting Started](getting-started.md) · [CLI command reference](commands.md).
