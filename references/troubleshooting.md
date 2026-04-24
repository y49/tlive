# Troubleshooting (v1.0)

Top issues users hit on a fresh v1.0 install. For release-time verification
see [docs/smoke-test.md](../docs/smoke-test.md).

## Daemon won't start

**Symptoms.** `tlive start` exits immediately or prints "address in use".

**Check.**
1. `tlive status` — reports stale state?
2. `tlive daemon-logs 200` — look for schema validation or socket errors.
3. Stale PID / socket: `rm ~/.tlive/daemon.pid ~/.tlive/daemon.sock`, retry.
4. Node version: `node --version` — must be ≥ 20 (22 recommended).

## `tlive setup` can't find existing config

**Symptoms.** Wizard claims first-run on a box that already had tlive.

**Cause.** Most often this is v0.x → v1.0 migration:
- v0.x stored `~/.tlive/config.env`.
- v1.0 expects `~/.tlive/config.json`.

**Fix.** Run `tlive setup` and let it migrate in place. The old file is
backed up as `~/.tlive/config.v0-backup.env`. If the migration fails,
back up `~/.tlive/` to somewhere safe, delete it, and start clean.

## Bot not responding

**Symptoms.** Messages to the bot never surface in IM, or responses never
arrive.

**Check (in order).**
1. `tlive doctor` — the per-platform probe catches token / auth issues.
2. `allowedUsers` in config — your user id listed?
3. Per-platform specifics:
   - Telegram: bot has been `/start`ed in DM, group chats disabled
     privacy, `requireMention` respected.
   - Discord: **Message Content Intent** enabled in Developer Portal.
   - Feishu: app published **and** admin-approved (not just submitted).
4. `tlive daemon-logs --follow` — you'll see inbound message events if
   the transport is healthy.

## Permission card buttons not working

**Symptoms.** You tap Allow/Deny/Always; nothing happens; card greys out.

**Check.**
1. Is the session still alive? `/status` — if not, §13.4 stale-recovery
   kicks in: the card edits to "session restored, new card sent". Wait
   for the new card.
2. Daemon socket reachable? `tlive status` should answer.
3. `tlive daemon-logs | grep CallbackRouter` — callback_data decode
   errors indicate a bug worth filing.
4. Discord-only: confirm `applications.commands` scope was granted on
   invite; button interactions ride the same interaction API.

## `/sessions` shows no entries

**Symptoms.** Brand-new install, `/sessions` is empty after several turns.

**Where sessions live (v1.0).**

```text
~/.claude/projects/<slug>/*.jsonl    # Claude Code SDK jsonl
~/.codex/sessions/*.jsonl            # Codex app-server jsonl
~/.tlive/sessions/<ws-id>/*.meta.json  # tlive's sidecar metadata only
```

**Check.**
- Workspace `workdir` matches the directory you're running in — the
  SDK's slug is derived from `workdir`.
- `SessionDiscovery` ran: `tlive daemon-logs | grep SessionDiscovery`
  shows it scanning at boot.
- Try `/sessions --global` to confirm it's not a per-workspace filter.

## MCP tool calls failing from Companion mode

**Symptoms.** Local `claude` reports "MCP server tlive not connected" or
tool calls return ENOENT.

**Check.**
1. `~/.claude/settings.json` contains:
   ```json
   { "mcpServers": { "tlive": { "command": "tlive", "args": ["mcp"] } } }
   ```
2. `tlive` is on `PATH` from the `claude` process's env.
3. Daemon is running (`tlive status`) — the MCP server talks to the
   daemon over the same socket.
4. `permissionPromptToolName: "mcp__tlive__approve"` spelled exactly
   right — a typo here routes permissions back to the local TUI.

## Cost showing $0.00

**Symptoms.** `/cost` returns zeros even though you've run multiple turns.

**Cause.** The session needs at least one completed turn with
`turn_end` emitting `usage` (input, output, cache_read, cache_create).

**Fix.** Kick a fresh turn: `/new hi`. If still $0 after the turn ends,
the runtime isn't emitting usage — check
`tlive daemon-logs | grep turn_end`. Known-good in v1.0 post-T6
(`CostTracker` correctly accumulates across resumes).

## Handoff says "session is busy"

**Symptoms.** `/handoff-to-me` or `claude --resume <alias>` fails with
"session is busy — another writer holds the jsonl".

**Cause.** The single-writer invariant is enforced by
`workspace.activeSessionId`. Another process is mid-turn.

**Fix.**
1. In IM: `/stop` to finish the current turn, then `/handoff-to-me`.
2. If the local `claude --resume` already held it and you forgot:
   `tlive stop <alias>` to force-release, then retry.
3. Worst case: `tlive list` to see what holds the alias, `tlive stop`
   to kill.

## MarkdownV2 escaping oddities (Telegram)

**Symptoms.** Messages render with stray backslashes (`\.\(` etc.).

**Cause.** Agent output containing special characters; the renderer must
escape them per MarkdownV2 rules. When the agent itself hand-wrote
escape sequences, they get re-escaped.

**Fix.** Usually harmless, but if you see `\_foo\_` where you expected
italics, the agent is fighting the renderer. Report the sample message
so the renderer can distinguish intent.

## Daemon memory grows

**Symptoms.** Bridge RSS climbs over hours of idle.

**Check.**
- `tlive status` — active session count. Idle sessions are stopped
  automatically after `TLIVE_SESSION_IDLE_HOURS` (default 24).
- `/prewarm off` on unused sessions to release runtime slots.
- `tlive stop-daemon && tlive start` resets heap; file an issue with
  `tlive version` + a heap trace if it returns quickly.
