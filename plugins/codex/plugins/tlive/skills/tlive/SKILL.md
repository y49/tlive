---
name: tlive
description: tlive — remote approvals (Telegram/Feishu/web), live web terminal, and
  session monitoring for Claude Code / Codex. Use for configuring or diagnosing
  tlive, connecting IM platforms, printing session links, or explaining approval
  behavior. Triggers "tlive", "IM bridge", "phone approvals", "remote terminal",
  "Telegram/Feishu notifications".
---

# tlive usage guide

tlive is a self-hosted approval/monitoring layer. Claude Code sessions report
through global hooks; Codex sessions are watched through an app-server
companion process (no hooks, no trust step). Approvals, completions, and
failures land in IM (Telegram/Feishu) and the web dashboard, where you can
approve/deny/reply-to-continue. The daemon auto-starts with new sessions
(disable via `daemon.autoStart: false`).

## Commands
- `tlive setup` — configure IM credentials + register the Claude/Codex plugins
  (hooks ride the Claude plugin; Codex needs none). `--hooks-only` re-registers
  plugins only; add `--claude` / `--codex` to pick a vendor.
- `tlive status` — daemon health, channels, and the Codex companion state
  (`running` / `degraded` / `off`; degraded or off = Codex approvals local-only).
- `tlive run <cmd>` — wrap a process: local terminal + live web terminal (QR to open).
- `tlive url` — print the dashboard link + QR code.
- `tlive logs -f` — follow the daemon log.
- `tlive start` / `tlive stop` — explicit lifecycle (start is rarely needed;
  sessions lazy-start the daemon unless autoStart is off).

## Diagnostics
1. No IM messages: `tlive status` for channel config; `tlive logs -f` for send
   errors; confirm the daemon is up after starting a session.
2. Codex has no remote cards: check `tlive status` — the companion line must say
   `running`. `off` means codex isn't on PATH (or Windows); `degraded` means the
   app-server child keeps dying — see `~/.tlive/codex-appserver.log`. Either way
   Codex still prompts locally; nothing is ever auto-run.
3. Claude approval card unanswered: the local dialog stays live the whole time
   (parallel channels, first answer wins); answering locally resolves the remote
   card as "answered in terminal". The remote window defaults to ~24h
   (`approvals.windowSec`, shared by both vendors).
4. Web page unreachable: `tlive url` for the current link (token is in the URL);
   phones need the same LAN (or your own reverse proxy/VPN — tlive has no
   `publicUrl` config, and cards never carry the link).

## Security model in one breath
- Never auto-allow: unanswered → Claude's local dialog governs / Codex's native
  prompt governs. Deny always carries a reason.
- Read-only tools (Read/Glob/Grep) pass by default. `/safe on` also auto-allows
  routine ops (non-dangerous Bash, non-sensitive edits) — the danger floor
  (rm -rf, sudo, .env/.ssh writes…) still asks and no config can lower it.
  `/trust on` pauses approvals entirely (high risk — pair with allowedSenders).
- Every runtime switch has two entrances flipping the same state: IM commands
  (/perm /trust /safe /desktop) and the CLI (`tlive perm|trust|safe|desktop
  on|off`). `/desktop` governs the local toast on the daemon's machine only.
- Vendor-side `permissions.deny` always wins; tlive never overrides it.

## First-time onboarding

When the user says "help me set up tlive" (or runs /tlive:setup), walk them
through:
1. `tlive status` to check the engine; missing → `npm i -g tlive`.
2. No channels → collect Telegram (bot token + chat id) or Feishu
   (appId + appSecret) credentials and merge into `~/.tlive/config.json`:
   `{ "allowedSenders": [], "adapters": { "telegram": { "token": "…", "chatIdAllowList": ["…"] }, "feishu": { "appId": "…", "appSecret": "…" } } }`
3. `tlive start` → `tlive status` to verify channels; `tlive url` for the dashboard.
4. Codex needs no extra step — the companion starts with the daemon. If status
   says `off`/`degraded`, that's diagnostic info, not a setup task.
