---
description: Guided tlive setup (IM channels, start, verification)
---

Guide the user through tlive setup. Execute in order, showing each result:

1. Run `tlive status`. If the command is missing → tell the user to install the
   engine first: `npm i -g tlive`, then re-run this command.
2. Read the output: an idle daemon is fine (sessions auto-start it); what
   matters is whether channels says `(none)`.
3. **Already configured (channels present)?** Don't just say "all set" — run
   the verification tour instead, one check at a time with its result:
   a. `plugins:` lines show the bundled version with a ✓ for every installed
      vendor (a mismatch → `tlive setup --hooks-only`).
   b. Have the user send the bot a message and confirm the reply arrives
      (proves the inbound path, not just the config).
   c. Ask the user to check the bot's command menu shows
      /perm /trust /safe /help (a stale client cache → close and
      reopen the chat).
   d. Desktop notifications: explain they fire on the computer only for things
      that need you to act — a pending approval, or the idle "waiting for your
      input" nudge. A finished turn and tool failures stay on IM (a per-turn
      toast would flood the screen). Toggle with `tlive desktop on|off` — it's
      a machine-local control, so there is no IM command for it.
   e. Hand out the dashboard via `tlive url`; suggest opening it once.
   f. Offer optional next steps: add another channel (continue below), or
      stop here.
   Then skip to step 8 unless the user wants a new channel.
4. If no channel (or adding one): ask whether the user wants Telegram, Feishu, or both, and
   collect credentials per platform:
   - Telegram: bot token (create via @BotFather) + chat id (send the bot a
     message and read getUpdates, or the user already knows it)
   - Feishu: appId + appSecret (self-built app on the open platform with im
     message permissions)
5. Read `~/.tlive/config.json` (may be absent or partial) and MERGE the new
   fields in (preserve existing ones):

   ```json
   { "allowedSenders": [],
     "adapters": {
       "telegram": { "token": "<token>", "chatIdAllowList": ["<chatId>"] },
       "feishu": { "appId": "<appId>", "appSecret": "<secret>" } } }
   ```
   (Only write the platforms the user chose; validate the JSON.)
6. `tlive stop` (if running) then `tlive start`, then `tlive status` to confirm
   the configured platforms appear under channels.
7. Have the user send the bot a test message; hand out the dashboard address
   via `tlive url`.
8. If status shows the Codex companion as `off` or `degraded`, explain what it
   means (codex missing from PATH / app-server child failing — see
   `~/.tlive/codex-appserver.log`); Codex approvals stay local-only until it is
   `running`. There is no trust step to perform.
