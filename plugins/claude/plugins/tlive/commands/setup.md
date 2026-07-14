---
description: Guided tlive setup (IM channels, start, verification)
---

Guide the user through tlive setup. Execute in order, showing each result:

1. Run `tlive status`. If the command is missing → tell the user to install the
   engine first: `npm i -g tlive`, then re-run this command.
2. Read the output: an idle daemon is fine (sessions auto-start it); what
   matters is whether channels says `(none)`.
3. If no channel: ask whether the user wants Telegram, Feishu, or both, and
   collect credentials per platform:
   - Telegram: bot token (create via @BotFather) + chat id (send the bot a
     message and read getUpdates, or the user already knows it)
   - Feishu: appId + appSecret (self-built app on the open platform with im
     message permissions)
4. Read `~/.tlive/config.json` (may be absent or partial) and MERGE the new
   fields in (preserve existing ones):

   ```json
   { "allowedSenders": [],
     "adapters": {
       "telegram": { "token": "<token>", "chatIdAllowList": ["<chatId>"] },
       "feishu": { "appId": "<appId>", "appSecret": "<secret>" } } }
   ```
   (Only write the platforms the user chose; validate the JSON.)
5. `tlive stop` (if running) then `tlive start`, then `tlive status` to confirm
   the configured platforms appear under channels.
6. Have the user send the bot a test message; hand out the dashboard address
   via `tlive url`.
7. If status shows the Codex companion as `off` or `degraded`, explain what it
   means (codex missing from PATH / app-server child failing — see
   `~/.tlive/codex-appserver.log`); Codex approvals stay local-only until it is
   `running`. There is no trust step to perform.
