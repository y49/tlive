---
description: Drive tlive daemon operations (handoff, takeback, status) from Claude Code.
---

Usage:

- `/tlive` — show available subcommands.
- `/tlive status` — show daemon state and live sessions.
- `/tlive handoff <alias>` — daemon releases the session; local claude
  continues it via `claude --resume <sdkSessionId>`.
- `/tlive takeback <sdkSessionId>` — daemon re-adopts a locally-driven
  session. Exit the local `claude --resume` first so there is no jsonl-
  writer contention.

# Implementation

Run the matching `tlive` CLI directly — it's a cross-platform Node binary
and speaks to the daemon over the same IPC endpoint the skill would
otherwise hand-roll. Dispatch on the first argument after `/tlive`:

- no argument → print the Usage block above.
- `status`   → `tlive status`
- `handoff`  → `tlive handoff $2`
- `takeback` → `tlive takeback $2`

The daemon endpoint is resolved by the CLI:

- POSIX: `${TLIVE_SOCKET_PATH:-$HOME/.tlive/daemon.sock}`
- Windows: `${TLIVE_SOCKET_PATH:-\\.\pipe\tlive-daemon}`

No bash scripts are required — the `tlive` CLI ships with
`npm install -g tlive` and works on Linux, macOS, and Windows.

# Examples

- User says "hand this off to the Telegram bot" → `/tlive handoff a1b2c3d4`.
- User says "take back this session" → `/tlive takeback <full-sdkSessionId>`.
- User asks "is this session owned by the daemon?" → `/tlive status`.
