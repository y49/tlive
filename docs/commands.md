# tlive CLI Command Reference

> **v2 CLI surface.** The shipped commands are exactly:
> `setup`, `start`, `stop`, `status`, `logs`, `run`, `url`, `hook`.
>
> Removed in v2.0: `restart`, `doctor` (folded into `status`),
> `daemon-logs` (renamed `logs`), `install-integrations` (folded into `setup`),
> `approve`, `workspace`, `version`, `update`.
> The workspace / `/use` / chat-binding subsystem is gone entirely.

---

## Daemon lifecycle

### `tlive start [--foreground|-F]`

Start the long-running daemon in the background (IPC + IM adapters + web
server). Prints the web URLs (local + LAN) and a QR code for your phone.
Idempotent — a second call reports the running daemon and reprints the URLs.

### `tlive stop`

Send a graceful shutdown request to the running daemon (idempotent — exits 0
with "not running" when the daemon is already down, so `stop && start` chains
work). Waits up to 2 s for the event loop to drain before forcing exit.

### `tlive status`

Show whether the daemon is running, its uptime, PID, and the configured IM
adapters, plus the web URLs and QR code. Replaces the removed `doctor`
subcommand.

### `tlive logs [N] [-f | --follow]`

Print the last N lines (default 50) of `~/.tlive/daemon.log` and optionally
tail new output. Replaces the removed `daemon-logs` subcommand.

---

## Wrapped sessions

### `tlive run <cmd> [args…]`

Wrap a process in a pty owned by THIS terminal: you use it locally as usual,
and the same session is served as a live web terminal at `/s/<id>` (and as a
preview card on the dashboard). Registers with the daemon (best-effort — the
local terminal still works when the daemon is down) and unregisters on exit.
Exit code is passed through.

Wrapped sessions additionally accept IM quote-reply text/photo injection and
web uploads. See README "The two integration levels".

---

## Hook integration

### `tlive hook [--codex] <event>`

Low-level shim invoked by the Claude Code / Codex hooks that ship inside the
tlive plugins. Reads the hook payload from stdin, contacts the daemon over
IPC, and writes the decision to stdout (`--codex` selects the Codex decision
wire). Not intended for direct user invocation.

---

## Wizard / setup

### `tlive setup [--hooks-only [--claude|--codex]]`

Interactive wizard that configures IM credentials (Telegram / Feishu) and
writes (or updates) `~/.tlive/config.json`. After configuration it registers
the bundled Claude Code / Codex plugins via each vendor's own plugin manager
(hooks + skill + `/tlive:*` commands ride along; no user config files are
hand-edited — see `docs/manual-hooks.md` for one-time cleanup of entries
written by pre-plugin dev builds, and for old vendor versions without a
plugin CLI).

`--hooks-only` skips the credential wizard and only re-registers the plugins —
run it after a `tlive` upgrade to refresh the vendors' plugin caches. By
default it installs for both vendors; pass `--claude` or `--codex` to limit
it to one.

Replaces the removed `install-integrations` subcommand. The workspace setup
step has been removed; notifications are delivered to all configured chats,
gated by `/perm on|off` (global mute).

---

### `tlive url`

Print the web dashboard URL (local + LAN) and a QR code. Focused shortcut for
when a full-screen TUI (claude) cleared the `tlive run` banner and you just
want the address again — run it in another terminal.

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
| `/trust on\|off` | Pause approvals (auto-allow everything) until turned off. High-risk; prefer the per-tool "Always allow" button. |
| `/help` | Show in-chat help. |
| *quote-reply + text* | Typed into that session's terminal (wrapped sessions). |
| *photo / file* | Downloaded to `~/.tlive/inbox`; path injected into the session. |

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
