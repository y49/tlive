# Getting Started with tlive v2.0

This guide takes you from zero to a working tlive setup. By the end you'll
have the daemon running, at least one IM bot connected, live monitoring of
your Claude Code / Codex sessions on your phone — and, if you turn it on,
approvals routing there too.

**Changed in v2.0:** tlive is no longer an SDK-driven IM bridge. It is a
vendor-neutral, self-hosted hook monitoring / approval layer. The daemon does
not own any agent sessions; your own `claude` / `codex` process runs locally
and reports through the tlive plugin's hooks. Its **default posture is
`notify`** — watch and notify only; remote approval (holding tool calls so you
can answer them from your phone) is opt-in via `tlive mode full`.

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

Codex needs no hooks and no trust step — that whole flow was retired.
Integration rides the app-server companion instead: tlive connects to a
`codex app-server` and your Codex TUIs attach to the same one. There is
nothing to approve and nothing to configure per session; see the README's
Codex section.

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
PID, configured adapters, the effective **`mode:`** line (default `notify`),
and the same URLs/QR; it replaces the removed `tlive doctor` subcommand.

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

You run `claude` (or `codex`) in your terminal as usual; the tlive plugin's
hooks report each event to the daemon over a local IPC socket. What happens
next depends on your **posture** (`tlive mode`):

**`notify` (default)** — tlive watches and notifies but never holds a tool
call:

1. Tool calls run with their normal **local** permission prompt — tlive
   short-circuits the `PermissionRequest` hook to a pass-through, so nothing
   is held or sent for remote approval.
2. When a permission prompt (or an `AskUserQuestion`) is waiting at the
   terminal, tlive tells you **on the machine**: a desktop toast and a
   read-only *waiting-approval* card on the dashboard — since only whoever is
   sitting there can act on it. IM stays quiet about these (a phone can't
   reach a terminal), except once ever per chat: the first time, a card
   explains why and offers the one-tap switch to `full`.
3. When the session stops or goes idle, the `Stop` hook sends an IM
   notification; reply with a continuation message to resume it.
4. Tool/session failures are pushed as side-channel `⚠️` messages.

**`full`** (`tlive mode full`) — everything in `notify`, plus remote approval:

1. When Claude wants to call a tool that needs approval, the
   `PermissionRequest` hook holds the decision and the daemon sends an
   approval card to all configured IM chats — **in parallel** with the local
   prompt (first answer wins).
2. You tap **Allow** or **Deny** on your phone (or answer at the keyboard).
3. The hook returns the decision to Claude; Claude continues or aborts.

**`all`** (`tlive mode all`) — everything in `full`, plus sub-agent approvals:

1. Sub-agent tool calls are held and made remotely answerable too, exactly
   like a main-session approval — with one trade: Claude Code decides whether
   to build a sub-agent's local dialog only *after* the hook returns, so a
   held sub-agent has **no** terminal prompt until the window ends (a timeout,
   or the phone/dashboard answer). Use it when nobody is at the keyboard;
   `tlive mode full` goes back to passing sub-agent prompts straight through.

Nothing is ever auto-approved or blanket-denied: if the daemon is unreachable,
the window expires, or no chat is configured, the hook falls back to `{}` and
control returns to the local terminal as if tlive weren't there.

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
- [Uninstalling / cleanup + migrating from v0.x/v1](uninstall.md)
- Back to [README.md](../README.md) for architecture overview.
