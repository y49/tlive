# tlive v1.0 Manual Smoke Test

Run this before tagging a release. All 13 steps must pass.

## Prerequisites

- Telegram / Discord / Feishu bot configured in `~/.tlive/config.env`.
- Node.js 20+, pnpm or npm.
- For Codex scenarios: `codex` CLI installed (`which codex`) and `OPENAI_API_KEY` set.
- `TL_WORKSPACES=smoke1:/tmp/smoke1,smoke2:/tmp/smoke2` in config; directories created.
- On Telegram: a **forum group** where the bot is admin (for topic support).

## Steps

### 1. Bridge starts cleanly

```bash
tlive start
tlive status
```

Expected: Bridge is running. Logs mention `Workspaces registered: N (smoke1, smoke2, <cwd-basename>)` — the list includes the two pre-configured entries plus one auto-registered default (named after `basename(cwd)`, e.g. `tlive` if bridge was started in the tlive repo).

### 2. `/workspaces` lists pre-configured entries + the auto-registered default

In IM (any configured platform), send `/workspaces`.

Expected: at least three entries — `smoke1`, `smoke2`, and one auto-registered default. All idle at this point.

If the bridge's cwd matches a pre-configured `TL_WORKSPACES` entry (e.g. `smoke1:/tmp/smoke1` and you ran `cd /tmp/smoke1 && tlive start`), the default is deduped by path and only the pre-configured entries appear.

### 3. `/open smoke1` creates a topic/thread

Send `/open smoke1`.

Expected (Telegram forum): A new forum topic named `smoke1` is created; bridge confirmation message appears in that topic.
Expected (Discord): A new thread named `smoke1` is created.
Expected (Feishu): The confirmation card header is prefixed `[smoke1]`.

### 4. Conversational turn with reasoning + agent reply

In the smoke1 topic, send: `What files are in this directory?`

Expected:
- Status line message shows "🧠 Thinking..." then updates to other phases.
- At verbose=0 (default), no activity_text or reasoning_summary arrives — just status line + permission (if agent asks to list files).
- Turn summary card lands at end.

### 5. Bump to verbose=1 and retry

Send `/verbose 1`. Then send `List files and describe what this looks like.`

Expected: reasoning_summary, activity_text (agent reply), turn card, file_change_list (if any) all arrive.

### 6. Trigger permission — verify context + buttons

Ask agent to run a command that requires approval (e.g., `Run "ls -la"`).

Expected permission notification includes:
- Tool name + input
- "Why" (agent's reasoning summary)
- Turn context (recent tools)
- 4 buttons: Allow / Allow always / Deny / Stop session

### 7. Tap Stop session

Expected: Session terminates cleanly. Status line updates to `done` with duration. Workspace `smoke1` is now idle in `/workspaces`.

### 8. Switch workspaces

Send `/open smoke2`.

Expected: Switches to smoke2 topic/thread. smoke1 remains in `/workspaces` list as idle.

### 9. Per-workspace preferences

In smoke1 topic: `/model opus` → check `/settings` shows model=opus.
In smoke2 topic: `/model haiku` → check `/settings` shows model=haiku.

Expected: each workspace independently holds its model value. `/settings` in smoke1 still shows `opus`.

### 10. Long content split

Ask agent for a long response (e.g., `Explain TypeScript generics in detail with 10 examples.`).

Expected: if response exceeds platform limit, it's split into `1/N`, `2/N`, etc. First piece includes a web terminal URL.

### 11. Bridge restart preserves workspaces

```bash
tlive stop
tlive start
```

Send `/workspaces`.

Expected: both smoke1 and smoke2 still listed. Topics/threads still work (send a message in smoke1 topic — agent responds in the same topic).

### 12. Scanner path (local PTY mode)

In a separate terminal: `tlive codex`. In the bot IM, send `/open sandbox /tmp/smoke-scan`.

Expected: `tlive codex` PTY writes .jsonl to `~/.codex/sessions/`. Scanner picks it up; IM gets notifications (activity_text, activity_tool) — but no reasoning_summary or file_change_list (expected — .jsonl is encrypted).

### 13. Clean shutdown

`Ctrl+C` in `tlive codex`. Run `tlive stop`.

Expected: Both processes exit cleanly. `~/.tlive/workspaces.json` persisted and valid JSON.

## Pass criteria

All 13 steps behave as expected. No crashes. No "Unknown event type" warnings except ones logged for known-limit scenarios.

## If something fails

1. `tlive logs 200` for bridge errors.
2. `tlive doctor` for environment diagnostics.
3. File an issue with: failing step, `tlive version`, `codex --version`, log excerpts.
