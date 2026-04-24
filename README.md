# tlive v1.0

> **The MCP-native agent fabric for IM.**
> One install, every agent everywhere gets session memory, IM notifications,
> remote approval, multi-agent orchestration, scheduled tasks, and a federated
> MCP registry. Drive Claude Code and Codex from Telegram, Discord, or Feishu
> with zero terminal interaction — or keep using your terminal and route
> permissions to your phone via MCP.

## Three ways to use tlive

- **Daemon mode** — IM is your only interface. `tlive start`, open your bot,
  send a message. Claude / Codex runs inside tlive's daemon.
- **Companion mode** — Keep using `claude` / `codex` locally. Configure
  `permissionPromptToolName: "mcp__tlive__approve"` — every permission goes to
  IM for remote approval when you're away.
- **Handoff** — Start on your phone in IM. Grab your laptop.
  `claude --resume <alias>` picks up exactly where you left off. Or use
  `/tlive takeback` from your terminal to hand back to IM.

## Quick start

```bash
npm install -g tlive

tlive setup                  # git-aware wizard: workspace + IM tokens
tlive install-integrations   # wire Claude skill + Codex prompt + MCP entry
tlive start                  # boot the daemon
tlive doctor                 # structured health check
```

## What changed from v0.x

v1.0 is a full rewrite. The PTY wrapper, jsonl file-system scanner, web
terminal, and hooks-bridge are all removed. IM is the primary interactive
surface; MCP is the programmatic entry point.

If you used v0.x as an IM-notified terminal wrapper: v1.0 is not backwards-
compatible. Pin to `tlive@0.8.x` or use plain Claude Code / Codex CLI.

On first run, `tlive setup` migrates your `~/.tlive/config.env` into
`~/.tlive/config.json`; the v0.x file is backed up at
`~/.tlive/config.v0-backup.env` (or `.v0-backup.json`).

## Highlights

- **45 IM slash commands** — mid-session `/model` / `/mode` / `/perm`, plus
  `/rewind`, `/fork`, `/budget`, `/cost`, `/status`, dynamic `/models` /
  `/agents`. Full reference in the skill docs.
- **8-anchor message UX** — reaction ack, session header, activity sticky,
  streaming agent response, 4-category permission cards, elicitation forms,
  todo sticky, attachments.
- **Multimodal** — send images and files from IM, Claude reads them. Claude
  creates files in the workspace → IM gets download links.
- **MCP federation** — one `tlive-self` entry in your agent's config gives
  every agent access to your session history, memory, notifications, and any
  downstream MCP server you register.
- **Sampling, resources (`tlive://…`), and prompts (`/prompts tlive-*`)** —
  tlive is a full MCP citizen, not just a tool namespace.
- **Warm runtime pool + cache-aware pre-warm** — cuts session start from
  ~500ms to ~50ms and keeps Anthropic's 5-minute prompt cache hot across
  your idle gaps.
- **Scheduled tasks** — `/schedule daily 9am tlive-daily-standup` — your
  sessions run themselves.
- **Cross-agent pipelines** — `/pipeline run plan-impl-review "refactor auth"`
  chains Claude-plans → Codex-implements → Claude-reviews.
- **Thread-per-session** on Telegram / Discord / Feishu.
- **Multi-chat mirror** — primary chat gets interactive buttons; mirrors see
  read-only renders scoped to their own chatId.
- **Approval policy learning** — click "Learn" on a permission card; the
  next matching request auto-resolves.
- **100% native jsonl compatibility** — `claude --resume <sdkSessionId>`
  works on any tlive-driven session.

## CLI surface

```
Daemon lifecycle
  tlive start                      Start the daemon
  tlive stop                       Stop gracefully
  tlive status                     Daemon + session snapshot
  tlive doctor                     Structured health check
  tlive daemon-logs [N] [-f]       Tail the daemon log

Handoff
  tlive handoff  <alias>           Release to local claude --resume
  tlive takeback <sdkSessionId>    Daemon re-adopts a local session

Wizards
  tlive setup                      Git-aware config wizard
  tlive install-integrations [all|claude|codex]
                                   Install Claude skill / Codex prompt

MCP
  tlive mcp                        stdio MCP server (for Claude / Codex)

Meta
  tlive version
  tlive update
```

Chat, prompts, runtime switching, budget — all driven through IM commands or
MCP tool calls. The CLI only manages the daemon.

## Config

Config lives at `~/.tlive/config.json`:

```json
{
  "version": "1",
  "workspaces": [
    { "id": "ws-…", "name": "tlive", "workdir": "/home/me/tlive",
      "gitRemote": "git@github.com:…", "defaults": { "provider": "claude" } }
  ],
  "channels": {
    "telegram": { "token": "…" },
    "discord":  { "token": "…" },
    "feishu":   { "appId": "…", "appSecret": "…" }
  },
  "permissions": { "allowedUsers": ["…"], "defaults": { "fs_write": "ask" } },
  "schedules":   [ /* cron tasks */ ],
  "mcpRegistry": { /* downstream MCP servers */ }
}
```

`tlive setup` edits this interactively and the config schema is validated on
daemon boot.

## Architecture

At a glance:

- **Daemon** (`src/daemon/`) — long-lived Node process, owns local Claude /
  Codex runtimes, routes MCP, fans out to IM adapters.
- **Runtime** (`src/runtime/`) — single `AgentRuntime` interface; Claude is
  backed by `@anthropic-ai/claude-agent-sdk`, Codex by `codex app-server`.
- **Session** (`src/session/`) — LocalSession (daemon owns a runtime) +
  RemoteSession (MCP-driven). Unified by `SessionLike`.
- **Permission / Attachment** (`src/permission/`, `src/attachment/`) — 4
  categories, policy learning, outbound + inbound file handling.
- **MCP** (`src/mcp/`) — tlive-self server, downstream federation, cron,
  cross-agent orchestrator, bundled servers.
- **IM** (`src/im/`, `src/platform/`) — SessionFrontend + 12 renderers +
  Telegram / Discord / Feishu adapters.

See `docs/superpowers/specs/2026-04-22-t14b-full-cutover-design.md` for the
complete v1.0 design.

## Development

```bash
git clone https://github.com/y49/tlive
cd tlive
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
