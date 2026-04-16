# Commands Reference

tlive uses `/` for two kinds of commands in IM:

- **Bridge commands** — handled by tlive itself (workspace management, bridge preferences)
- **CLI commands** — passed through to the running Claude Code / Codex session (`/clear`, `/compact`, etc.)

Any `/command` not in the bridge whitelist is forwarded as a regular message to the active session, so Claude Code's and Codex's own slash commands "just work" in IM.

---

## Bridge commands

### Workspace

| Command | Description |
|---------|-------------|
| `/workspaces` | List all workspaces with status (idle/running, last activity) |
| `/open <name\|path>` | Enter a workspace. Path creates a new one; name reuses existing. |
| `/new` | End the current workspace session. Send a message to start fresh. |
| `/stop` | Interrupt the currently-running turn (like Ctrl+C). Session stays. |

### Per-workspace preferences

These apply to the current workspace (open one first via `/open`):

| Command | Runtime | Description |
|---------|---------|-------------|
| `/model <name>` | both | Set the AI model for this workspace |
| `/effort <low\|medium\|high\|max>` | both | Thinking depth / reasoning budget |
| `/verbose <0\|1\|2>` | both | Notification verbosity (0=quiet, 1=normal, 2=full) |
| `/perm <on\|off>` | Claude | Permission prompts on/off |
| `/mode <default\|read-only\|safe-yolo\|yolo>` | Codex | Permission mode preset |
| `/approval <on-request\|on-failure\|never>` | Codex | Approval policy (advanced) |
| `/sandbox <read-only\|workspace-write\|danger-full-access>` | Codex | Sandbox mode (advanced) |

### Codex permission modes

`/mode` bundles approval + sandbox into sensible presets:

| Mode | approvalPolicy | sandbox | Use |
|------|---------------|---------|-----|
| `default` | `on-request` | `workspace-write` | Safe + interactive (asks on escalation) |
| `read-only` | `never` | `read-only` | Browse / plan only |
| `safe-yolo` | `on-failure` | `workspace-write` | Low interruption |
| `yolo` | `never` | `danger-full-access` | Fast + risky |

### Bridge utilities

| Command | Description |
|---------|-------------|
| `/menu` | Open the interactive control panel |
| `/status` | Bridge status: uptime, active sessions, counts |
| `/settings` | Show current workspace configuration |
| `/runtime <claude\|codex\|auto>` | Switch the runtime for this chat |
| `/help` | Show bridge command help |

### Admin

| Command | Description |
|---------|-------------|
| `/approve <code>` | Approve a pairing request (Telegram admin only) |
| `/pairings` | List pending pairing requests |

---

## CLI command passthrough

Any `/command` not listed above is forwarded verbatim to the active Claude Code / Codex session. Common examples:

| Command | Runtime | What it does |
|---------|---------|-------------|
| `/clear` | both | Clear conversation context |
| `/compact` | Claude | Summarize conversation to save context |
| `/cost` | Claude | Show session cost breakdown |
| `/exit` | both | End the CLI session |

**Caveat**: commands that overlap with bridge commands (`/model`, `/help`) are handled by the bridge. tlive's `/model` sets the workspace default; Claude's `/model` opens a picker — these have slightly different purposes but converge on "set model for future turns". If you need Claude's native `/model` picker specifically, use the Claude Code CLI directly.

---

## Permission card buttons

When a tool needs approval, you'll see an interactive card with:

- **✅ Allow** — allow this specific call (one-time)
- **🔓 Always** — allow + whitelist tool for the rest of this session (no more prompts for this tool)
- **❌ Deny** — reject this call

---

## Session lifecycle vs execution

- `/stop` — **interrupts the current turn** (like Ctrl+C). The session stays active; send another message to continue.
- `/new` — **ends the session entirely**. Next message starts fresh with no prior context.

Analogously: `/stop` is "pause this thought"; `/new` is "forget this conversation, let's start over".

---

## Per-platform notes

### Telegram
- Bridge commands appear in the `/` autocomplete menu
- Forum groups: each `/open` creates a new forum topic

### Discord
- Bridge commands work as regular messages (no native `/` command registration yet)
- Threads are auto-created per workspace

### Feishu
- Each workspace prepends `[name]` to card titles for visual separation
- Cards use schema V2 with column-set button layouts
