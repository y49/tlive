# tlive

Terminal live monitoring + IM bridge for AI coding agents — wrap [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://developers.openai.com/codex) with web-accessible terminal + Telegram / Discord / Feishu bridges.

## Features

- **Workspace-first IM interaction.** Open projects as workspaces; each gets its own Telegram topic / Discord thread / Feishu card tag. Switch between `~/tlive` and `~/blog` without mixing message streams.
- **Dual-path Codex support.** Via `@openai/codex-sdk` for IM-initiated conversations (reasoning + file changes + todos), or via `.jsonl` scanner for local-PTY monitoring.
- **Status line per session.** Edit-in-place progress message shows current phase (thinking / reading / editing / awaiting approval).
- **Permission context.** Approval prompts include the agent's reasoning and recent tool calls so you can decide with confidence.
- **Verbose levels.** Default Quiet = permissions + final results. Normal adds reasoning + file changes. Full = every tool call.
- **Per-workspace preferences.** Model, effort, approval policy, sandbox mode — each workspace holds its own.

## Quick Start

```bash
npm install -g tlive

# One-time setup (configure Telegram / Discord / Feishu bot)
tlive setup

# Start the IM bridge daemon
tlive start

# Option A: wrap Claude Code
tlive claude

# Option B: wrap Codex CLI
tlive codex
```

Pair your phone via the URL in terminal output, or via the Telegram/Discord/Feishu bot.

## Commands (in IM)

```
/workspaces              List all workspaces with status
/open <name|path>        Enter a workspace (creates if path, reuses if exists)
/stop                    Interrupt current turn (Ctrl+C); session stays
/new                     End session; next message starts fresh

/model <name>            Workspace model (Claude/Codex)
/effort low|medium|high|max
/verbose 0|1|2           Notification level

/perm on|off             Claude: permission prompts
/mode default|read-only|safe-yolo|yolo   Codex: permission preset

/settings, /status, /menu, /help
```

Any other `/command` (e.g. `/clear`, `/compact`) passes through to the active
Claude Code / Codex session. Full reference: [docs/commands.md](docs/commands.md).

Preferences are scoped per workspace — `/perm on` in `tlive` doesn't affect `blog`.

## Pre-configured Workspaces

Add to `~/.tlive/config.env`:

```
TL_WORKSPACES=tlive:/home/y/tlive,blog:/home/y/blog
TL_WORKSPACES_ALLOWED=/home/y/
```

Pre-configured workspaces appear immediately in `/workspaces`. `TL_WORKSPACES_ALLOWED` is an optional prefix whitelist — any `/open <path>` outside the whitelist is rejected.

## Codex-Specific Env

- `CODEX_HOME` — defaults to `~/.codex`. Session files are in `$CODEX_HOME/sessions/`.
- `TLIVE_CODEX_EXECUTABLE` — path to `codex` binary if not on `PATH`.
- `OPENAI_API_KEY` — required for bridge-initiated Codex sessions.

## Architecture

tlive has two routes to agent events:

1. **Bridge SDK path (IM-initiated).** The bridge daemon uses `@openai/codex-sdk` (Codex) or `@anthropic-ai/claude-agent-sdk` (Claude) to start sessions on demand when you type in IM. Full reasoning + structured file changes.
2. **Local scanner path.** You run `tlive codex` / `tlive claude` in a terminal; tlive scans the agent's session file (`.jsonl` under `~/.codex/sessions/` or `~/.claude/projects/`) and forwards notifications to IM. The PTY is yours to see; IM is a remote observer.

See `docs/smoke-test.md` for a 13-step verification checklist run before each release.

## Limitations

- `.jsonl` scanner mode cannot see Codex reasoning content (OpenAI encrypts it at rest) or structured file diffs. Use the SDK path for full fidelity.
- Codex app-server mode (full unified-diff + streamed reasoning delta) is not yet supported; planned for 1.1.
- Telegram multi-workspace separation requires the chat to be a forum-enabled supergroup. Non-forum chats fall back to tag-mode (workspace prefix in each message).

## Development

```bash
git clone https://github.com/y49/tlive
cd tlive
npm install
npm run typecheck
npm run test:all
npm run build:all
```

## Migration from 0.x

If you used earlier versions:
- `tlive-core` Go binary is gone. `tlive start` runs the bridge daemon in Node.
- Docker images removed — local daemon mode via `tlive start`.
- Hook-based architecture removed — no Claude Code hook installation needed.

Config in `~/.tlive/config.env` remains compatible.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (if present) for code style, branch conventions, and the test gate (typecheck + test:all + build:all must pass).
