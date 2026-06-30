# tlive CLI Command Reference

> **v2.0 CLI surface.** The shipped commands are exactly:
> `setup`, `start`, `stop`, `status`, `logs`, `hook`.
>
> Removed in v2.0: `restart`, `doctor` (folded into `status`),
> `daemon-logs` (renamed `logs`), `install-integrations` (folded into `setup`),
> `approve`, `workspace`, `version`, `update`.
> The workspace / `/use` / chat-binding subsystem is gone entirely.

---

## Daemon lifecycle

### `tlive start`

Start the long-running daemon in the background. Writes a PID file and IPC
socket to `~/.tlive/`. Idempotent — a second call exits cleanly if the daemon
is already running.

### `tlive stop`

Send a graceful shutdown request to the running daemon. Waits up to 2 s for the
event loop to drain before forcing exit.

### `tlive status`

Show whether the daemon is running, its uptime, PID, and the configured IM
adapters. Also runs lightweight credential probes (replaces the removed
`doctor` subcommand).

### `tlive logs [N] [-f | --follow]`

Print the last N lines (default 50) of `~/.tlive/daemon.log` and optionally
tail new output. Replaces the removed `daemon-logs` subcommand.

---

## Hook integration

### `tlive hook <event>`

Low-level shim that `~/.claude/settings.json` hooks call. Reads the hook
payload from stdin, contacts the daemon over IPC, and writes the decision to
stdout. Not intended for direct user invocation.

---

## Wizard / setup

### `tlive setup [--hooks-only]`

Interactive wizard that configures IM credentials (Telegram / Feishu) and
writes (or updates) `~/.tlive/config.json`. After configuration it also
installs the Claude Code hooks into `~/.claude/settings.json` (idempotent).

`--hooks-only` skips the credential wizard and only reinstalls the hooks —
useful after a `tlive` upgrade.

Replaces the removed `install-integrations` subcommand. The workspace setup
step has been removed; notifications are delivered to all configured chats,
gated by `/perm on|off` (global mute).

---

## Global flags

### `tlive --version`

Print the installed tlive version and exit. Replaces the removed `version`
subcommand.

---

## IM commands (in-chat)

These are typed in your Feishu or Telegram chat — they are **not** CLI
subcommands.

| Command | Description |
|---|---|
| `/perm on\|off` | Global mute toggle — `off` suppresses all outbound notifications. |

---

## Removed commands (v2.0)

| Removed | Replacement |
|---|---|
| `tlive restart` | `tlive stop && tlive start` |
| `tlive doctor` | `tlive status` |
| `tlive daemon-logs` | `tlive logs` |
| `tlive install-integrations` | `tlive setup` (or `tlive setup --hooks-only`) |
| `tlive approve <id>` | Tap the Approve button in IM |
| `tlive workspace add\|list\|remove` | Removed — no workspace subsystem in v2 |
| `tlive version` | `tlive --version` |
| `tlive update` | Use `npm install -g tlive@latest` |
| `/use <workspace>` | Removed — no chat-binding model in v2 |
