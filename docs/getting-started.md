# Getting Started with tlive v2.0

This guide takes you from zero to a working tlive setup. By the end you'll
have the daemon running, at least one IM bot connected, and Claude Code /
Codex hook approvals routing to your phone.

**Changed in v2.0:** tlive is no longer an SDK-driven IM bridge. It is a
vendor-neutral, self-hosted hook approval and monitoring layer. The daemon
does not own any agent sessions; your own `claude` / `codex` process runs
locally and calls tlive's hooks via `~/.claude/settings.json`.

## Prerequisites

- **Node.js 20+** and npm (Node 22 recommended).
- **Claude Code** installed locally.
- An IM account on **Telegram** or **Feishu**. You can enable both.

## Install

```bash
npm install -g tlive
tlive --version
```

## Configure — `tlive setup`

```bash
tlive setup
```

The wizard first registers the tlive plugin (hooks, skill, `/tlive:*`
commands) with each detected vendor's own plugin manager — if both `claude`
and `codex` are on `PATH` it asks which to install into (`[1] Claude Code
[2] Codex [3] both`, default both). Only after that does it prompt for IM
credentials (Telegram bot token + chat ID, or Feishu app credentials); this
step is fully optional — press Enter through it to skip, then later say
"help me configure tlive" inside Claude Code or Codex — or, in Claude
Code, run `/tlive:setup` — and the AI will walk you through it
interactively (Codex has no slash commands; the phrase works there). Whatever
you do enter is written (or merged) into:

```text
~/.tlive/config.json
```

When the Codex plugin is installed, setup also **automatically trusts the
tlive hooks** with Codex (via `codex app-server`'s `hooks/list` RPC,
self-checked and rolled back on failure) — see the README's Codex section
for how, and the manual `/hooks` fallback if it doesn't go through.

To re-register plugins only (e.g. after a tlive upgrade):

```bash
tlive setup --hooks-only
```

Secure the file:

```bash
chmod 600 ~/.tlive/config.json
```

## Connect a bot

Pick your platform and follow the detailed guide:

- [Telegram](setup-telegram.md) — fastest, ~5 min
- [Feishu / Lark](setup-feishu.md) — ~15 min, needs workspace admin approval

## Start the daemon

```bash
tlive start
tlive status
```

`tlive start` prints the web URLs (local + LAN) **and a QR code** — scan it
once on your phone to open the dashboard. `tlive status` shows daemon uptime,
PID, configured adapters, and the same URLs/QR; it replaces the removed
`tlive doctor` subcommand.

## Wrap a session (optional but recommended)

```bash
cd your-project
tlive run claude
```

`tlive run` gives the SAME session three extra powers on top of hooks-only:

- a **live web terminal** at `/s/<id>` (multi-device; whoever types owns the
  layout) and a live preview card on the dashboard;
- **IM quote-reply injection** — reply to any of this session's IM messages
  and your text is typed into the terminal;
- **photo/file feeding** — send an image in IM (or paste/drop on the web
  page, or use the dashboard 📎): it lands in `~/.tlive/inbox` and its path
  is typed into the session.

Want the session to survive closing your terminal? Combine with tmux:
`tmux new -s work tlive run claude`.

---

## How it works

1. You run `claude` (or `codex`) in your terminal as usual.
2. When Claude wants to call a tool (`Bash`, `Write`, etc.), the
   `PreToolUse` hook calls `tlive hook pre-tool-use`, which contacts the
   daemon over a local IPC socket.
3. The daemon sends an approval card to all configured IM chats.
4. You tap **Allow** or **Deny** on your phone.
5. The hook returns the decision to Claude; Claude continues or aborts.

When Claude stops, the `Stop` hook sends a notification; reply with a
continuation message to resume it.

All hooks fail-open silently (no auto-approve, no blanket deny) when the
daemon is unreachable or the timeout expires, returning control to the local
terminal.

---

## Troubleshooting basics

- **`config not found`** → run `tlive setup`.
- **`daemon unreachable`** → `tlive start`. If it says "already running"
  but `tlive status` disagrees, remove the stale socket:
  `rm ~/.tlive/daemon.sock` and retry.
- **Bot token looks fine but no messages arrive** → `tlive status` runs a
  live per-platform probe (`getMe` for Telegram,
  `tenant_access_token` for Feishu).
- **Permission card buttons do nothing** → check
  `tlive logs --follow` for errors. Usually a stale card from before a
  daemon restart — resend the triggering message.

## Next steps

- [CLI command reference](commands.md)
- Platform setup guides: [Telegram](setup-telegram.md) · [Feishu](setup-feishu.md)
- Back to [README.md](../README.md) for architecture overview.
