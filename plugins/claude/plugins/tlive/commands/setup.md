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
      /mute /trust /safe /mode /help (a stale client cache → close and
      reopen the chat).
   d. Desktop notifications: explain one fires per thing that needs you to
      act — a pending approval, or the idle "waiting for your input" nudge —
      and tlive never touches it again afterward; it just ages into the
      notification centre like any other app's, so that's a log, not a live
      status board (open the dashboard for what's waiting right now). A
      finished turn notifies the desktop too, after the same grace as the IM
      card; tool failures stay on IM, since they block nobody. There is no
      separate on/off switch: use the OS's Do
      Not Disturb to silence them temporarily, or `tlive mode off` to stop
      tlive entirely.
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
8. Offer remote approval. tlive defaults to `notify` (watch + notify only — it
   never holds a tool call, so a fresh install can't hang a workflow). Ask
   whether the user wants to Allow/Deny tool calls from their phone; if yes, run
   `tlive mode full` (holds each tool call for a remote answer, in parallel with
   the local prompt — first answer wins; revert any time with `tlive mode
   notify`). If they only want monitoring, leave it in `notify`. If they also
   want sub-agent approvals on their phone (e.g. they're about to step away),
   that's `tlive mode all` — flag the trade: a held sub-agent has no terminal
   dialog until the window ends, so it only pays off when nobody is at the
   keyboard (`tlive mode full` goes back).
9. If status shows the Codex companion as `off` or `degraded`, explain what it
   means (codex missing from PATH / nothing answering on the app-server socket
   — see `~/.tlive/codex-appserver.log`); Codex approvals stay local-only until
   it is `running`. There is no trust step to perform, and no restart either:
   tlive keeps checking, so installing codex clears it on its own.
