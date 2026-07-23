---
description: Show tlive daemon, channel, and Codex companion status
---

Run `tlive status` and show the output to the user verbatim. If the `mode:`
line says `notify` (the default), point out that remote approval is off — tlive
only watches + notifies, and tool prompts stay local; enable phone Allow/Deny
with `tlive mode full`. `full` means remote approval is on; `off` disables
tlive entirely. If the Codex line says `degraded` or `off`, explain: Codex
approvals are local-only right now (the native prompt still works; nothing is
ever auto-run) — `off` usually means codex is not on PATH, `degraded` means the
app-server child keeps failing (see `~/.tlive/codex-appserver.log`).
