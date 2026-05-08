# tlive v1.0 Manual Test Checklist

This is the v1.0 release-verification walkthrough — run it end-to-end on a
clean machine (or at least a clean `~/.tlive/`) before tagging. It covers
the **live-environment DoD items** from spec §22 that can't be asserted in
unit tests.

All 15 steps must pass. Each step shows: **what to do**, **what you should
see**, and **how to diagnose** if it fails.

## Prerequisites

- Node.js 20+, npm or pnpm.
- `claude` and `codex` CLIs installed locally (`which claude`, `which codex`).
- At least one configured IM bot (Telegram is easiest for smoke; see
  [setup-telegram.md](setup-telegram.md)).
- A throwaway workspace at `/tmp/tlive-smoke` with a git remote (for the
  `tlive setup` git-aware path).
- Optional: a second chat (channel/group) for the multi-chat mirror step.

### Install the local build as a global `tlive` command

The smoke test exercises the **post-publish user flow**, not a dev-loop
invocation. That means running the real `tlive` bin, not `node scripts/cli.js`.
Use `npm link` to symlink this checkout into your global `bin/`:

```bash
# from the repo root
pnpm install         # or npm install
npm run build        # produces dist/src/tlive-*.mjs

npm link             # symlinks ./scripts/cli.js → $(npm prefix -g)/bin/tlive

which tlive          # should point to the global link
tlive --help         # dispatcher works end-to-end
```

This is the closest local approximation to `npm install -g tlive`. It also
catches path-resolution bugs in `scripts/cli.js` that only surface when the
bin is called from elsewhere on disk (the dispatcher resolves
`dist/src/tlive-*.mjs` relative to the link target, not the caller's cwd).

When you're done smoke-testing, tear it back down:

```bash
npm unlink -g tlive  # or: npm rm -g tlive
```

### Platform notes

This checklist assumes a POSIX shell (Linux / macOS). Windows adaptations:

- **IPC transport.** v1.0 picks the right shape per platform automatically:
  POSIX uses a unix-domain socket at `~/.tlive/daemon.sock`; Windows uses
  a named pipe at `\\.\pipe\tlive-daemon`. Override via `$TLIVE_SOCKET_PATH`
  or `daemon.socketPath` in config if you need a custom endpoint.
- **`npm link`** works on Windows but may need Developer Mode or admin for
  symlinks; `npm config get prefix` must be on `$PATH`.
- **Shell commands below** (`rm -rf`, `mkdir -p`, `cat <<'EOF'`) — on
  Windows PowerShell use `Remove-Item -Recurse -Force`, `New-Item -ItemType Directory`,
  and here-strings. Cmd.exe users should run from Git Bash or WSL.
- **Handoff.** The Claude skill's `/tlive handoff` / `/tlive takeback`
  subcommands dispatch to the `tlive` CLI (Node, cross-platform) — no
  shell scripts are shipped. `tlive handoff <alias>` and `tlive takeback
  <sdkSessionId>` also work directly from any terminal.
- **Daemon spawn** uses `windowsHide: true`, so `tlive start` on Windows
  won't pop up a visible console window — the daemon runs fully detached.

### Clear any prior state

```bash
rm -rf ~/.tlive ~/.claude/skills/tlive
mkdir -p /tmp/tlive-smoke && cd /tmp/tlive-smoke && git init . && \
  git remote add origin git@github.com:example/smoke.git
```

---

## Steps

### 1. Daemon starts cleanly

```bash
tlive setup                   # walk through wizard, paste Telegram token
tlive install-integrations
tlive start
tlive status
```

**Expected.** `tlive status` reports `daemon: running`, workspace
`tlive-smoke` registered, 0 active sessions, PID matches
`~/.tlive/daemon.pid`, socket at `~/.tlive/daemon.sock` exists.

**If it fails.** Check `tlive daemon-logs 200` for the crash trace. Common
cause: stale PID/socket from a previous run — remove them and retry.

### 2. `tlive doctor` — all-green

```bash
tlive doctor
```

**Expected.** Every check is `✅`:
- config schema valid
- daemon reachable on socket
- at least one channel authenticated (Telegram `getMe` OK)
- warm pool initialised
- MCP self server boots
- `claude --version` ≥ expected; `codex --version` ≥ expected

**If it fails.** The failing section includes a remediation hint. For
per-platform auth failures, use the platform guide.

### 3. First session — lazy-resume-or-create

Open the bot's DM in IM. Send **any plain text**, e.g.:

```text
what's in this directory?
```

**Expected.** Within ~1s:
- 👁️ reaction on your message.
- Session header message appears, pinned if the platform supports.
- Activity sticky evolves: `🧠 thinking…` → `🔧 LS /tmp/tlive-smoke` → streamed reply.
- No permission card (LS is allowlisted by default).

**If it fails.** `tlive daemon-logs --follow` while resending. A common
issue is `workdir` mismatch — the daemon's cwd when `tlive start` ran
drives workspace default.

### 4. Permission flow — `tool_use`

In the same IM chat:

```text
please run `npm test` here
```

**Expected.** A **permission card** arrives:
- Category: exec.
- Shell block with syntax-highlighted `npm test`.
- "Why" summary.
- Buttons: Allow / Deny / Always / 💡 Learn.

Click **Allow**. The activity sticky switches to `🔧 Bash(npm test)` and
streams the command output. On completion: `✅ done`, cost badge updates.

**If it fails.** Check the card's metadata with the callback_data inspector
(`tlive daemon-logs | grep CallbackRouter`). Stale cards across daemon
restarts trigger the §13.4 recovery flow — expected behaviour.

### 5. Elicitation form

Requires a configured MCP tool with `sampling` or an input schema. If one
isn't set up, you can use the bundled `ask-user-question` prompt:

```text
use the ask-user-question tool to collect my name and favourite language
```

**Expected.** The platform renders its native form:
- **Telegram**: forceReply sequence — one question per reply message.
- **Feishu**: interactive card with form blocks.

Submit values; they reach the tool call as structured output.

### 6. Mid-session runtime adjustments

Inside the active session, send:

```text
/model opus
/mode safe-yolo
/effort high
```

**Expected.** For each command:
- A brief `✅ model → opus` confirmation.
- Session header badge updates (`🤖 opus`, mode indicator, etc.).
- Next turn uses the new setting.

### 7. `/sessions` + `/resume`

```text
/sessions
```

**Expected.** Paginated list (8/page). Each row: alias · title · last
activity · cost · ⚡/❄ cache indicator.

Archive the current session (`/archive <alias>`), create a new one
(`/new just a quick note`), then:

```text
/resume <first-alias>
```

**Expected.** The daemon restores the jsonl through `SessionManager.resumeLocal(sdkId)`,
`workspace.activeSessionId` flips to the resumed session, header + sticky
reappear. Send a plain message — it continues the prior conversation.

### 8. `/cost` — per-session + workspace

```text
/cost
/cost today
/cost week
```

**Expected.** Each invocation returns a table:
- Per-session USD breakdown (input / output / cache read / cache write).
- Workspace subtotal.
- Agent-type breakdown (Claude / Codex).

**Changed in v1.0:** cost accumulates correctly across resumes (the T6 bug
where `turn_end` usage was lost on resume is fixed).

### 9. Multi-chat isolation

Bind two different chats (e.g., one Telegram + one Feishu) to the same workspace
via `/workspace [📁 <ws-name>]` in each chat.

In each chat run:

```text
/cost
/sessions
```

**Expected.**
- `/cost` returns per-chat cost independently (costs from chat A do not bleed
  into chat B's view).
- `/sessions` returns only that chat's own sessions (chat A cannot see chat B's
  session list).

Then in one chat:

```text
/workspace [📁 other-ws]
```

**Expected.** That chat switches to the other workspace; the second chat's
workspace binding is unaffected.

### 10. Companion mode

Configure `~/.claude/settings.json` as in
[getting-started.md §Mode B](getting-started.md#mode-b--companion-mode-local-cli--mcp).

Locally:

```bash
cd /tmp/tlive-smoke
claude
# (inside the local Claude session)
please run `ls -la`
```

**Expected.**
- Local Claude *pauses* (no local permission prompt).
- IM receives the permission card tagged `💻 remote from local claude`.
- Click Allow in IM. Local Claude unblocks and runs `ls -la`.
- `/sessions` in IM lists the remote session with the 💻 badge.

### 11. Handoff roundtrip

Inside a Daemon-mode session in IM:

```text
/handoff-to-me
```

**Expected.** IM posts
`📲 handed off to you — claude --resume <alias>`. Locally:

```bash
claude --resume <alias>
```

Claude picks up conversation. In local Claude run:

```text
/tlive takeback <alias>
```

**Expected.** Local claude exits cleanly; IM resumes rendering; the next
IM message drives the same session.

### 12. Scheduled task

```text
/schedule create daily 09:00 "summarise yesterday's commits"
/schedule list
```

Advance the cron manually (set your system clock forward, or use the test
endpoint over the IPC socket — see `src/mcp/self/cron.ts` for the debug
entry if compiled with `TLIVE_CRON_DEBUG=1`).

**Expected.** At fire time IM receives a fresh session with the scheduled
prompt, runs the turn, and posts the result as a normal agent reply.

### 13. MCP federation

```text
/mcp install github
/mcp list
```

**Expected.** `/mcp list` shows `tlive-self` + `github` with connection
status. Tools from github appear under `github.*` prefix. Invoke one:

```text
please list my open github PRs
```

Claude calls `github.listPullRequests`; result streams back.

### 14. Policy learning

Trigger a permission request (e.g. `please run "ls"`), click **💡 Learn**
on the card. Acknowledge the "remember this" prompt.

Next turn, send `please run "ls src/"`.

**Expected.** No permission card — the pattern `Bash(ls *)` matched the
learned policy, the tool runs straight away. `/perm list` shows the new
entry.

### 15. Daemon reboot resilience

While a session is mid-turn (agent is `🧠 thinking`):

```bash
tlive stop
tlive start
```

**Expected.**
- `tlive status` reports `daemon: running` again.
- §13.2 auto-resume picks up `workspace.activeSessionId` (marked
  `running` + `lastActivityAt < 24h`) and resumes via
  `SessionManager.resumeLocal(sdkId)`.
- IM posts an informational note: `"session <alias> auto-resumed"`.
- Session continues where it left off on next user input.

---

## CI-style checklist

```text
[ ]  1. tlive start + tlive status — clean
[ ]  2. tlive doctor — all ✅
[ ]  3. First session: lazy-resume-or-create
[ ]  4. tool_use permission — Allow flow
[ ]  5. Elicitation form — platform-native render
[ ]  6. /model /mode /effort — mid-session switch visible in header
[ ]  7. /sessions paginated, /resume works
[ ]  8. /cost — session + workspace totals
[ ]  9. Multi-chat isolation — per-chat cost + sessions independent
[ ] 10. Companion mode — IM approval unblocks local claude
[ ] 11. Handoff roundtrip — daemon → local → daemon
[ ] 12. Scheduled task fires
[ ] 13. MCP federation — install github, invoke
[ ] 14. Policy learning — next match auto-resolves
[ ] 15. Daemon reboot — selective auto-resume
```

## Pass criteria

All 15 boxes ticked. No `Unknown event type` warnings in
`tlive daemon-logs 500` other than ones already filed in the backlog.

## If something fails

1. `tlive daemon-logs 500` for the failing window.
2. `tlive doctor` for env diagnostics.
3. File an issue with the step number, the failure output, `tlive version`,
   `claude --version`, `codex --version`.
