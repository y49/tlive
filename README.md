# tlive

[![npm version](https://img.shields.io/npm/v/tlive)](https://www.npmjs.com/package/tlive)
[![CI](https://github.com/y49/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/y49/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README_CN.md)

> **A vendor-neutral, self-hosted "remote approval + monitoring" layer for AI coding agents.**
>
> On the couch or on the go, when Claude Code / Codex stalls on a permission
> prompt — tlive uses the **open hook mechanism** both vendors already support
> to push approvals and status notifications to **the channel you pick
> (Feishu included)**. Approve from your phone and it keeps going. Works across
> Claude / Codex, **regardless of subscription or API key**, and your **session
> and data never leave your machine**.

## How it works

tlive **does not drive your session** — you run your own `claude` / `codex`
in the terminal as usual. tlive just installs a few hooks into
`~/.claude/settings.json`:

- **`PreToolUse`** → before each tool call, push an approval card to
  Feishu/Telegram; you tap Allow/Deny, and the hook blocks until you answer.
- **`Stop`** → when Claude stops, push a notification; reply with a line to
  resume it.
- **`Notification` / `PostToolUse`** → status / tool-activity notifications.

The session is always your local interactive `claude` — it stays within your
subscription limits and never routes through any vendor cloud. **When no chat
is bound or it times out, the hook exits silently and falls back to the local
terminal prompt** (no auto-approve, no blanket deny).

## Why not the official remote?

Official remotes (Claude Remote Control / Codex on mobile) have **structural,
permanent gaps**:

- **Cross-agent** — Anthropic's remote won't control Codex, and vice versa;
  tlive handles both with one setup.
- **API-key users** — official remote explicitly doesn't support them; tlive
  doesn't care how you authenticate.
- **Self-hosted** — official runs on vendor cloud; tlive runs on your machine.
- **Feishu** — official Channels only cover Telegram / Discord / iMessage;
  tlive is Feishu-native.

tlive fills exactly that — the layer the vendors structurally can't and won't build.

**What it does NOT do**: tlive doesn't do "write code from scratch on your
phone" — leave that to official Remote Control / Codex mobile, which do it
better and for free. tlive only does approval, notification, and monitoring.

## Quick start

```bash
npm install -g tlive

tlive setup                 # wizard: workspace + IM credentials (Telegram / Feishu)
tlive install-integrations  # write hooks into ~/.claude/settings.json
tlive start                 # start the long-running daemon

# then run, as usual, in your workspace directory:
claude
```

When a tool call needs approval, your bound Feishu / Telegram receives a card
with buttons.

## CLI surface

```
Daemon lifecycle
  tlive start | stop | restart | status | doctor | daemon-logs

Hook integration
  tlive hook <event>          Claude hook shim (reads stdin, outputs decision; called by Claude)
  tlive install-integrations  write ~/.claude/settings.json hooks (idempotent)
  tlive approve <requestId>   CLI fallback to approve a pending permission

Workspace
  tlive workspace add | list | remove

Wizard / Meta
  tlive setup
  tlive version | update
```

## Architecture

- **Daemon** (`src/kernel/daemon/`) — long-running Node process running the IPC
  server + IM adapters; brokers approvals / resumes / notifications.
- **Hook shim** (`src/cli/subcommands/hook.ts` + `src/kernel/hook/normalizer.ts`)
  — the thin entry Claude calls: stdin → IPC → decision.
- **Brokers** (`src/kernel/daemon/permission-router.ts`,
  `src/kernel/permission/continue-broker.ts`) — route a request to the IM chat
  bound to its workspace and block for the answer.
- **IM adapters** (`src/adapters/im/`) — Telegram (grammy), Feishu (lark).
- **IPC** (`src/kernel/ipc/`) — cross-platform unix socket / Windows named pipe.

`claude` / `codex` are **your own processes**; tlive integrates loosely through
the hooks in their settings — no SDK, no version pinning, no vendor cloud.

## Upgrading from v1.0

v1.0 was an IM bridge that drove sessions via the Agent SDK. v2.0 switches to
the hook layer (see `CHANGELOG.md`). This is a breaking change with no automatic
migration: re-run `tlive setup` + `tlive install-integrations`. The v1.0
architecture is preserved at git tag `v1.0-sdk-bridge`.

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
