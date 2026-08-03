# tlive CLI Command Reference

> **v2 CLI surface.** The frozen core is exactly:
> `setup`, `start`, `stop`, `status`, `logs`, `run`, `url`, `hook`.
> Additive since: `mode` (posture: off / notify / full / all) and the runtime
> toggles `mute`, `trust`, `safe` (`on|off`, same setters as the in-chat IM
> commands).
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
subcommand. Also prints the effective **`mode:`** line (off / notify / full /
all) — the first thing to check when an approval card never arrives (in the
default `notify` mode tlive never sends one; see `tlive mode`).

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
gated by `/mute on|off` (global mute).

---

### `tlive url`

Print the web dashboard URL (local + LAN) and a QR code. Focused shortcut for
when a full-screen TUI (claude) cleared the `tlive run` banner and you just
want the address again — run it in another terminal.

---

## Posture & runtime toggles

### `tlive mode off|notify|full|all`

Set tlive's **posture** — one coarse switch above every fine toggle, in
escalation order (how much tlive intercepts). Persisted to
`~/.tlive/config.json` and read by the hook shim on every event, so it takes
effect on the **next hook** — no daemon restart, no new session.

| Mode | What it does |
|---|---|
| `off` | Every hook is a no-op — no gating, notifications, monitoring, or daemon autostart (kill switch). |
| `notify` (default) | Watch + notify only. The shim short-circuits every `PermissionRequest` to a pass-through `{}` — tlive **can never hold or block an approval**; every prompt stays 100% native. A prompt waiting at the terminal reports **to the machine** — desktop toast + read-only dashboard card — since only whoever is sitting there can act on it. IM stays quiet about these (a phone can't reach a terminal), except once ever per chat: the first time, a card explains why and offers the one-tap switch to `full`. Monitoring, turn-finished / waiting notifications, and reply-to-continue all still reach IM — those ARE answerable from a phone. |
| `full` | Remote approval ON for the main session — this is the posture that puts approvals **on your phone**: tlive holds each tool call so you can Allow/Deny it from IM / desktop / dashboard, in parallel with the terminal dialog (first answer wins). Sub-agent prompts still pass through to the terminal untouched. |
| `all` | Sub-agent approvals are held too. **A held sub-agent has NO terminal dialog until the window ends** — Claude Code awaits the hook before deciding whether to build one — so this is the "nobody is at the keyboard" posture; `tlive mode full` goes back. |

Remote approval is opt-in by design: a freshly-installed tool must never be
able to silently hang a workflow. `tlive status` shows the effective mode.
Also settable from IM: `/mode off|notify|full|all` sets it directly, and a
bare `/mode` replies with a card listing every rung and marking the current
one, with tap-to-switch buttons.

### Sub-agent card buttons

Two affordances exist only as buttons on IM cards — there is no other way to
reach them:

- **"Hold sub-agents from now on"** — rides the pass-through notice sent when
  a sub-agent prompt falls through to the terminal on `full` (that prompt
  itself can only be answered at the keyboard; this button is for the *next*
  one). Tapping it switches posture to `all`.
- **"Answer at the terminal instead"** — rides a HELD sub-agent approval card
  on `all`. Releases that one request so Claude Code builds its terminal
  dialog, exactly as if tlive weren't holding it.
- **"Stop holding sub-agents"** — also on the held sub-agent card. Switches
  posture back to `full`.

### `tlive mute|trust|safe on|off`

The same runtime switches as the in-chat IM commands, from the CLI:

- `tlive mute on|off` — silence IM notifications (IM only; the desktop toast is
  unaffected, see below).
- `tlive trust on|off` — pause approvals (auto-allow everything). High-risk.
- `tlive safe on|off` — also auto-allow routine ops (non-dangerous Bash,
  non-sensitive edits); the danger floor still asks.

These flip in-memory daemon state (cleared on restart), unlike `mode`, which
persists to config.

### Desktop notifications

Desktop notifications appear whenever something is blocking on you and
disappear when it is answered. There is no separate on/off switch: use your
OS's Do Not Disturb to silence them temporarily, or `tlive mode off` to stop
tlive entirely. Without `notify-send` (or the platform equivalent) they
silently no-op.

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
| `/mute on\|off` | Global mute toggle — `off` suppresses all outbound IM notifications. |
| `/trust on\|off` | Pause approvals (auto-allow everything) until turned off. High-risk; prefer the per-tool "Always allow" button. |
| `/safe on\|off` | Auto-allow routine ops (non-dangerous Bash, non-sensitive edits); the danger floor still asks. |
| `/mode off\|notify\|full\|all` | Set posture. A bare `/mode` replies with a card listing the ladder and marking the current rung, with tap-to-switch buttons. |
| `/help` | Show in-chat help. |
| *quote-reply + text* | Typed into that session's terminal (wrapped sessions). |
| *photo / file* | Downloaded to `~/.tlive/inbox`; path injected into the session. |

Tapping a bare command from the client's command menu (which sends `/mute`,
`/trust`, or `/safe` with no `on|off` argument) replies with explicit on/off
buttons instead of an error — a menu tap can never one-shot enable a dangerous
state like `/trust`. A bare `/mode` works the same way, but replies with the
full ladder (see above) instead of a plain on/off pair.

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
