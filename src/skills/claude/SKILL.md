---
name: tlive
description: IM bridge for Claude Code — use when working with tlive sessions, handing off to/from Telegram/Discord/Feishu, searching past sessions, pushing IM notifications, or configuring MCP access through the tlive-self server.
---

# tlive skill

`tlive` is an MCP-native agent fabric that turns Telegram / Discord / Feishu
into first-class control surfaces for Claude Code and Codex. When this skill
activates, Claude has access to the `tlive-self` MCP server (bundled with the
daemon) plus the `/tlive` slash command for handoff operations.

## When to activate

Activate when the user:

- Mentions **tlive**, **IM bridge**, **消息桥接**, **手机交互**, or the
  **`/tlive`** slash command.
- Wants to hand control of the current session off to (or take control back
  from) a daemon-managed IM session (`/tlive handoff`, `/tlive takeback`).
- Asks to search / list / export past tlive sessions.
- Asks to push a notification to Telegram / Discord / Feishu.
- Asks Claude to upload an artifact to the tlive attachment store.
- Asks about configuring tlive MCP access, permissions, or policies.

## Three modes tlive operates in

| Mode | Owner of runtime | Typical user |
|------|------------------|--------------|
| **Daemon** (Mode A) | `tlive` daemon | Mobile-first, chat driven |
| **Companion** (Mode B) | Local `claude` / `codex` CLI | Desk-at-terminal |
| **Handoff** | Switches between A and B | Mixed workflow |

`/tlive handoff` flips Mode A → Mode B (daemon releases session, local CLI
continues from the same jsonl). `/tlive takeback <alias>` flips Mode B → Mode
A (daemon re-owns the session; local CLI should exit).

## Available MCP tools (via `tlive-self`)

Call these with `mcp__tlive__<tool>` once the user has run
`tlive install-integrations claude` so the MCP entry lives in
`~/.claude/settings.json`.

### Session & memory

- `tlive.sessions.list` — enumerate sessions (live + persisted).
- `tlive.sessions.search` — full-text search over past transcripts.
- `tlive.sessions.get` — fetch a single session's metadata + transcript.
- `tlive.sessions.export` — dump to markdown / json.
- `tlive.memory.get` / `tlive.memory.set` — per-workspace key/value memory.

### IM + approvals

- `tlive.notify.im` — push a message to the workspace's bound IM chat.
- `tlive.approve` — request permission approval from the bound IM chat
  (surfaces a permission card; the IM user decides).
- `tlive.ask.remote` — AskUserQuestion via IM (multi-choice, free-form).

### Artifacts + orchestration

- `tlive.artifact.upload` — attach a file to the workspace's attachment store.
- `tlive.sessions.orchestrate` — fan out a prompt across multiple sessions.
- `tlive.handoff.release` / `tlive.handoff.take` — programmatic equivalents
  of the `/tlive` slash commands.

## `/tlive` slash command

The `/tlive` slash command invokes the cross-platform `tlive` Node CLI
(no shell scripts). Dispatch:

```
/tlive                       show available subcommands
/tlive status                -> tlive status
/tlive handoff <alias>       -> tlive handoff <alias>
/tlive takeback <sdkId>      -> tlive takeback <sdkId>
```

The daemon endpoint is resolved automatically (unix socket on Linux/macOS,
named pipe on Windows), so the same slash command works on every platform.

## Output convention for IM

When tlive renders your output in an IM chat:

- Prefer **terse Markdown**; IM clients re-flow text aggressively.
- For long code / logs, call `Write` with the full content and reference the
  file by name instead of pasting into the message.
- Avoid tables — they render poorly on Telegram/Feishu mobile.
- Code fences work on all three platforms; use language hints so the
  renderer's escape logic picks the right lexer.

## Quick reference

- Install / patch config: `tlive install-integrations claude`
- Daemon control: `tlive start` / `tlive stop` / `tlive status` / `tlive doctor`
- Daemon logs: `tlive daemon-logs [N] [--follow]`
- Session control lives in IM: `/sessions`, `/kill`, `/stop`, `/resume`. The
  CLI no longer manages individual sessions.
