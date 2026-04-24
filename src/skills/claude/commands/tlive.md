---
description: Drive tlive daemon operations (handoff, takeback, status) from Claude Code.
---

Usage:

- `/tlive` — show available subcommands.
- `/tlive status` — show this session's daemon relationship.
- `/tlive handoff` — daemon releases current session; local claude continues.
- `/tlive takeback <alias>` — daemon takes over a session; local claude exits.

# Implementation

Dispatch on the first argument ($1 after `/tlive`):

- no argument → print the usage block above.
- `status` → run `~/.claude/skills/tlive/scripts/status.sh` (falls back to
  `tlive status` when absent).
- `handoff` → run `~/.claude/skills/tlive/scripts/handoff.sh` with the current
  session's short alias (if detectable via `$CLAUDE_SESSION_ID`, otherwise
  the script reads it from `tlive list`).
- `takeback` → run `~/.claude/skills/tlive/scripts/takeback.sh $2`, then
  suggest the user exits local claude so the daemon owns the session.

Scripts talk to the daemon via its unix socket at
`${TLIVE_DAEMON_SOCK:-$HOME/.tlive/daemon.sock}`. They assume `curl` is
available; if it isn't, fall back to `tlive handoff-to-me` / `tlive takeback`
CLI commands once those land.

# Examples

- User says "hand this off to the Telegram bot" → `/tlive handoff`.
- User says "take back workspace abc" → `/tlive takeback abc`.
- User asks "is this session owned by the daemon?" → `/tlive status`.
