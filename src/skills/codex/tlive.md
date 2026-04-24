# tlive — IM-native agent fabric (Codex prompt)

Load this prompt via `/prompts tlive` to teach your Codex agent how to use
the bundled `tlive-self` MCP tools. Codex doesn't support custom slash
commands, so handoff operations are driven by natural language + MCP tool
calls rather than a `/tlive` shortcut.

## What tlive is

tlive is an MCP server and daemon that links Claude Code / Codex to Telegram,
Discord, and Feishu. It owns:

- Native jsonl session storage (no lock-in; `codex --resume` works on any
  tlive-driven session).
- Permission cards rendered as IM buttons.
- Cross-session search and federated MCP registries.
- Cron-scheduled tasks and orchestrated pipelines.

## Three modes

- **Daemon (Mode A)** — tlive owns the runtime; IM is the only interface.
- **Companion (Mode B)** — local Codex CLI drives; tlive is an MCP tool belt.
- **Handoff** — the two modes exchange ownership of the same session id.

## MCP tools you can call

All tools are exposed under the `tlive` MCP server:

- `tlive.sessions.list` — enumerate live + persisted sessions.
- `tlive.sessions.search` — full-text across past transcripts.
- `tlive.sessions.get` — fetch one session's metadata + transcript.
- `tlive.sessions.export` — dump session to markdown / json.
- `tlive.memory.get` / `tlive.memory.set` — workspace-scoped memory.
- `tlive.notify.im` — push a message to the bound IM chat.
- `tlive.approve` — request IM-side permission approval.
- `tlive.ask.remote` — AskUserQuestion via IM.
- `tlive.artifact.upload` — attach a file to the workspace.
- `tlive.sessions.orchestrate` — fan out a prompt to multiple sessions.
- `tlive.handoff.release` — ask the daemon to release the current session.
- `tlive.handoff.take` — ask the daemon to reclaim a session.

## Handoff via natural language

When the user asks to "hand off to the bot" or "let Telegram drive this":

1. Confirm the current session id (`tlive.sessions.list`).
2. Call `tlive.handoff.release` with that id.
3. Post a short note on the IM side via `tlive.notify.im`.

When the user asks to "take over from the bot" or "stop the daemon on this":

1. Call `tlive.handoff.take` with the session's short alias.
2. Suggest the user exits local Codex so the daemon is the sole driver.

## IM output convention

If your output is going to end up in a Telegram / Discord / Feishu message:

- Keep it terse; prefer bullet points to prose.
- Use fenced code blocks with language hints.
- Avoid tables (mobile clients collapse them).
- For large outputs, write to a file and reference the path; tlive will
  attach it via `tlive.artifact.upload` on request.

## Quick start

- Install / patch config: `tlive install-integrations codex`
- Daemon control: `tlive start` / `tlive stop-daemon` / `tlive status`
- Session control: `tlive list` / `tlive stop <alias>` / `tlive logs <alias>`
