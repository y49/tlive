# IM Commands Reference (v1.0)

tlive v1.0 ships **45 IM slash commands**. They all run inside a bound IM chat
(Telegram, Discord, or Feishu) against the tlive daemon — the CLI itself no
longer offers chat/session subcommands.

**Changed in v1.0:** The old "bridge commands vs CLI passthrough" split is
gone. Commands are no longer forwarded to `claude` / `codex`; instead, tlive
merges Claude Code's `supportedCommands` (fetched at runtime from the SDK)
into its own `/help` output so SDK-native commands like `/clear`, `/compact`,
`/cost` remain discoverable. Commands removed in v1.0: `/workspaces`,
`/open`, `/end`, `/menu`, `/approve`, `/pairings`, `/runtime`.

Each command is dispatched by `src/im/command-parser.ts` to a handler in
`src/im/commands/<name>.ts`. Every handler declares the minimum role
(`admin | operator | observer`) required to invoke it.

Autocomplete: the 16 most-common commands register via the platform API
(Telegram `setMyCommands`, Discord `applications.commands.put`, Feishu
mention menu). The rest are discoverable via `/help`.

---

## Quick reference — top 10 examples

```text
/new refactor the auth module                       # create + send first prompt
/new --model=opus --effort=high plan the migration  # override defaults
/stop                                               # interrupt the current turn
/resume a1b2c3d4                                    # resume a prior session by alias
/sessions                                           # paginated list, 8/page
/cost week                                          # weekly per-workspace total
/model opus                                         # swap model mid-session
/perm allow "Bash(npm test)"                        # whitelist a tool pattern
/handoff-to-me                                      # release jsonl, continue locally
/mcp install github                                 # add a federated MCP server
```

---

## Session lifecycle (10)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/help` | `/help [cmd]` | observer | List commands. Merges SDK `supportedCommands` into the output. |
| `/new` | `/new [--ephemeral] [--model=M] [--effort=E] [prompt]` | operator | Create a new session. `--ephemeral` = non-persistent (not written to jsonl on disk). |
| `/stop` | `/stop` | operator | Interrupt the current turn (like Ctrl+C). Session stays alive. |
| `/kill` | `/kill` | admin | Force-kill the runtime slot and release the underlying jsonl lock. |
| `/resume` | `/resume <alias>` | operator | Resume a session by its 8-char alias. |
| `/sessions` | `/sessions [--archived] [--global]` | observer | Paginated 8/page. `--global` includes other workspaces. |
| `/archive` | `/archive <alias>` | operator | Archive (not delete); hidden from `/sessions` unless `--archived`. |
| `/fork` | `/fork <alias> [as "<title>"]` | operator | Clone a session — shares jsonl history up to fork point, diverges after. |
| `/rename` | `/rename <alias> "<title>"` | operator | Change the human-readable title in session meta. |
| `/takeback` | `/takeback <alias>` | operator | (Handoff) Daemon takes ownership of a session a local `claude` currently owns. |

---

## History / time (6)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/search` | `/search [--global] <text>` | observer | Full-text search over this workspace's session history (or all workspaces). |
| `/export` | `/export <alias> [md\|json\|jsonl]` | operator | Export a session transcript. Default `md`. |
| `/time-travel` | `/time-travel <alias> <msg-id>` | operator | Rewind the *view* to a prior message — session continues from that point in-memory. |
| `/rewind` | `/rewind <msg-id>` | admin | File-level rewind: truncates jsonl back to the given message. Destructive. |
| `/cost` | `/cost [today\|week\|month] [--global]` | observer | Per-session + per-workspace rollups. Accumulated from `turn_end` usage events. |
| `/whoami` | `/whoami` | observer | Your user id, role in this workspace, and the current workspace name. |

---

## Runtime adjustment — mid-session (10)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/model` | `/model [<m>]` | operator | Show or set model. No arg lists SDK-reported models (via `/models`). |
| `/mode` | `/mode [<mode>]` | operator | Permission preset. Values: `default`, `read-only`, `safe-yolo`, `yolo` (Codex names; Claude maps to nearest). |
| `/effort` | `/effort [<level>]` | operator | Thinking budget. `low\|medium\|high\|max`. |
| `/perm` | `/perm allow\|deny\|list <pattern>` | admin | Edit the per-workspace permission allow/deny list. |
| `/thinking` | `/thinking [collapsed\|expanded\|hidden]` | operator | How reasoning blocks render in IM. |
| `/verbose` | `/verbose [0\|1]` | operator | Message verbosity. 0 = final answer only; 1 = full activity sticky + tool cards. |
| `/budget` | `/budget [<usd>]` | admin | Per-session USD spending cap enforced by `BudgetGuard`. |
| `/prewarm` | `/prewarm [on\|off]` | operator | Keep a warm runtime in the pool between turns (preserves cache). |
| `/cancel-queued` | `/cancel-queued [<n>]` | operator | Drop queued inputs (from messages sent while the agent was thinking). |
| `/stop-task` | `/stop-task <agent-short-id>` | operator | Stop one subagent without killing the whole session. |

---

## Introspection (5)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/status` | `/status` | observer | Live snapshot: daemon uptime, agent phase, cache state, cost, queue depth. |
| `/models` | `/models` | observer | Dynamic list from the SDK. Includes deprecation flags when present. |
| `/agents` | `/agents` | observer | Subagents currently running (their short-id, task, duration). |
| `/plugins` | `/plugins [list\|enable <n>\|disable <n>\|reload]` | admin | Local plugins registered in `src/plugins/`. |
| `/mcp` | `/mcp [list\|add <json>\|remove <n>\|reconnect <n>\|toggle <n> on\|off\|install <name>]` | admin | Downstream MCP servers via federation (`src/mcp/federation/`). |

---

## Workspace / multi-chat (5)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/workspace` | `/workspace [show\|set-default\|system-prompt "<text>"]` | admin | Edit per-workspace fields. `set-default` pins this workspace for plain-text messages in this chat. |
| `/bind` | `/bind [<workspace-name>]` | admin | Bind the current chat to a workspace as `primary`. With no args, binds to the only workspace this user admins. |
| `/mirror` | `/mirror [add primary\|add mirror\|remove\|list]` | admin | Multi-chat: primary chat has interactive buttons; mirrors see read-only renders. |
| `/pairings` | `/pairings` | admin | List which chats are bound to which workspaces (replaces v0.x pending-pairings flow). |
| `/grant` | `/grant <user> <admin\|operator\|observer>` | admin | Assign a role to a user in this workspace. |

---

## Handoff + companion (2)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/handoff-to-me` | `/handoff-to-me` | operator | Daemon releases the jsonl lock. Continue locally with `claude --resume <alias>`. |
| `/companion` | `/companion [status\|accept <agent>\|reject <remoteId>]` | admin | Manage pending RemoteSession registrations from local `claude` / `codex` processes using tlive as MCP. |

> **Tip:** Also `/takeback <alias>` (listed under Session lifecycle) goes the
> other way — daemon reclaims ownership from a local CLI.

---

## Agent / skill authoring (2)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/agent` | `/agent [list\|create <name> "<desc>" [--model=X] [--tools=…]\|remove <n>]` | admin | Manage SDK subagents (definitions are persisted and synced into the SDK config). |
| `/skill` | `/skill [list\|install <path\|url>\|remove <n>]` | admin | Install a Claude skill into `~/.claude/skills/` from a path or git URL. |

---

## Multi-user (group chats) (2)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/revoke` | `/revoke <user>` | admin | Remove a user's role; falls back to `defaultRole` (usually `observer`). |
| `/attach-last` | `/attach-last` | operator | Re-upload the last file Claude created to the current IM chat. |

---

## Advanced MCP (3)

| Command | Syntax | Role | Description |
|---|---|---|---|
| `/pipeline` | `/pipeline [list\|create <name> <steps>\|run <name> <input>\|remove <n>]` | admin | Cross-agent orchestration (e.g. `claude-plan → codex-impl → claude-review`). |
| `/schedule` | `/schedule [list\|create <cron\|at\|daily\|weekly> <prompt>\|remove <id>]` | admin | Cron tasks that fire prompts at scheduled times. |
| `/handoff` | alias of `/handoff-to-me` | operator | Short form provided for parity with `/tlive` skill subcommands. |

---

## Fallback semantics (no active session)

Commands that *require* an active session (`/stop`, `/kill`, `/model`,
`/mode`, `/effort`, `/thinking`, `/perm`, `/budget`, `/prewarm`,
`/cancel-queued`, `/stop-task`, `/handoff-to-me`, `/time-travel`) post a
hint: `"no active session — /new or /resume <alias> first"`.

Commands that operate on historical state (`/sessions`, `/cost`, `/search`,
`/export`, `/archive`, `/rename`, `/fork`, `/resume`) work without an active
session.

---

## Forwarded SDK commands (`/help` integration)

Claude Code's `supportedCommands` (e.g. `/clear`, `/compact`) are fetched
from the SDK at daemon start and merged into `/help`'s output so IM users
can discover them without looking at the Claude Code docs. They're
delivered to the SDK via the runtime's input channel, not intercepted by
tlive — so they behave exactly as if typed at the local `claude` prompt.

**Changed in v1.0:** tlive no longer owns a special pass-through list. Any
`/<name>` not registered in `src/im/commands/` is treated as a user message
and forwarded verbatim to the SDK as the user's next turn input — identical
to typing it in the terminal.

---

## Permission card buttons

When a tool needs approval you'll see a **permission card** (one of four
templates — exec / file-edit / generic / elicitation). Buttons:

- **Allow** — allow this specific call (one-time).
- **Deny** — reject this call.
- **Always** — allow + whitelist matching tool pattern for the rest of this
  session.
- **Learn** (💡) — open the policy-learning prompt so the next matching
  request auto-resolves without a card. See §9.8 of the v1.0 spec.

Elicitation cards use native UI: Telegram forceReply sequence, Discord Modal,
Feishu interactive form.

---

## Per-platform notes

- **Telegram** — autocomplete via `setMyCommands`. Forum-group topics:
  each session may get its own topic when the chat is a forum.
- **Discord** — slash commands registered via
  `applications.{id}.commands.put`. Each session runs inside its own thread
  (`startThread`).
- **Feishu** — no slash-command menu API; use `@bot /<cmd>`. Sessions get
  their own topic when supported (new-style groups).

See [getting-started.md](getting-started.md) for the mode walkthroughs and
the platform-specific setup guides for bot creation.
