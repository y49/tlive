# tlive

> Drive Claude Code / Codex from your phone via IM. Permission prompts don't block when you're away.

## What it does

tlive is a small daemon that bridges Telegram or Feishu chats to Claude Code / Codex sessions running on your machine. Use cases:

1. **短暂离开** (coffee, meeting): permission prompts go to your phone via IM; approve there, terminal session continues uninterrupted.
2. **长时离开** (out of office, commute): hand off your terminal session to the daemon, drive new turns from IM, take it back when you're at a computer again.

Built for solo developers who don't want to install yet another app.

## What it is NOT

- Not a framework, plugin marketplace, or extension platform — see `KERNEL.md` for the frozen surface
- Not multi-tenant — single user assumed
- Not a Web UI / mobile app — IM is the only frontend
- Not maintained on a fast roadmap — 1.0 is intentionally frozen for 3 months after release

## Quick start

```bash
# 1. Install
npm install -g tlive

# 2. Configure (interactive)
tlive setup

# 3. Wire up Claude Code / Codex
tlive install-integrations

# 4. Register your project as a workspace
cd ~/your-project
tlive workspace add

# 5. Start daemon
tlive start

# 6. From your phone (in TG or Feishu): send any message → it goes to Claude in your project
```

## Architecture

```
┌─ IM Adapters (Telegram / Feishu) ─┐
│ Kernel (frozen surface)             │
└─ Runtime Adapters (Claude / Codex) ┘
```

See `KERNEL.md` for the frozen API contracts and `docs/superpowers/specs/2026-05-11-tlive-kernel-redesign-design.md` for full design rationale.

## CLI

Daemon: `tlive start | stop | restart | status | doctor | daemon-logs`
Workspaces: `tlive workspace add | list | remove`
Handoff: `tlive handoff` (terminal session → IM-driven)
Permission fallback: `tlive approve <requestId> yes|no`
Setup: `tlive setup | install-integrations`
MCP server entry: `tlive mcp` (called by Claude/Codex)
Meta: `tlive version | update`

## IM commands (in your bound chat)

- `/use <ws>` — switch chat to a different workspace
- `/new` — start new AI session
- `/sessions` — list active sessions
- `/resume <id>` — switch to existing session
- `/handback` — release session for terminal `claude --resume <id>`
- `/stop` `/kill` — interrupt / kill current session
- `/help` — full list

## License

MIT
