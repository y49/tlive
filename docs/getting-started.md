# Getting Started with tlive

This guide takes you from zero to a working tlive setup. By the end, you'll be able to monitor terminal sessions from your phone, chat with Claude Code via IM, and approve permissions remotely.

## Prerequisites

- **Node.js 18+** and npm
- One of: **Telegram**, **Discord**, or **Feishu** account (for IM Bridge and Hook Approval)
- **Claude Code** or **Codex** installed (required for IM Bridge and Hook Approval features)
- The **Web Terminal** feature works standalone — no IM platform needed

## Install

```bash
npm install -g tlive
```

Verify the installation:

```bash
tlive --help
```

**What happens during install:** npm downloads the tlive Go Core binary for your platform (macOS/Linux, arm64/amd64) and copies hook scripts to `~/.tlive/bin/`. If you see errors about the Go Core binary, re-run `npm install -g tlive`.

## Choose Your IM Platform

You can enable one or more platforms simultaneously. Here's a quick comparison to help you decide:

| Platform | Best for | Setup time |
|----------|----------|------------|
| **Telegram** | Individual developers. Create a bot with @BotFather in 2 minutes. | ~2 min |
| **Discord** | Teams already on Discord. Requires a server you can admin. | ~5 min |
| **Feishu** | Chinese teams on Feishu/Lark. More involved setup (needs admin approval). | ~15 min |

Detailed platform guides:

- [Telegram Setup](setup-telegram.md)
- [Discord Setup](setup-discord.md)
- [Feishu Setup](setup-feishu.md)

## Configure

Pick whichever method suits you best.

### Option A: AI-Guided Setup (Recommended)

Inside Claude Code, run:

```
/tlive setup
```

The AI walks you through each step interactively — it will explain what each config value means, help you create bot tokens, and verify everything works.

### Option B: CLI Wizard

```bash
tlive setup
```

Interactive prompts guide you through platform selection and credentials. Good if you already have your bot tokens ready.

### Option C: Manual Configuration

Edit `~/.tlive/config.env` directly. Use [config.env.example](../config.env.example) as a reference for all available options.

Key settings:

```env
# Which platforms to enable (comma-separated)
TL_ENABLED_CHANNELS=telegram

# Telegram example
TL_TG_BOT_TOKEN=7823456789:AAF-xxxxx
TL_TG_CHAT_ID=123456789

# Web terminal port and access token
TL_PORT=4590
TL_TOKEN=your-secret-token
```

Make sure to secure the config file:

```bash
chmod 600 ~/.tlive/config.env
```

### Claude Code Settings Sources

`TL_CLAUDE_SETTINGS` controls which Claude Code settings files to load. Default: `user`.

| Value | Loads | Use case |
|-------|-------|----------|
| `user` | `~/.claude/settings.json` | Auth, model, env (e.g. `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) |
| `project` | `.claude/settings.json` + `CLAUDE.md` | Project rules, MCP, skills |
| `local` | `.claude/settings.local.json` | Developer overrides |

```env
TL_CLAUDE_SETTINGS=user            # Default — user config only
TL_CLAUDE_SETTINGS=user,project    # User + project config
TL_CLAUDE_SETTINGS=                # Full isolation
```

> **Tip:** If you use tools like **ccswitch** that set `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, the default `user` setting already covers this.

## Install Claude Code Integration

```bash
tlive install skills
```

This registers:

- The `/tlive` skill for Claude Code
- Hook scripts for permission approval (`PreToolUse`, `Notification`)
- Notification handlers for task completion alerts

## Try It Out

### Feature 1: Web Terminal

Wrap any command with `tlive` to get a web-accessible terminal:

```bash
tlive echo "Hello from tlive!"
```

Open the URL shown in the output — you'll see a live web terminal. Try it with a real workload:

```bash
tlive claude --model opus
```

You'll get both a local and network URL. Open the network URL on your phone to monitor the session remotely.

### Feature 2: IM Bridge

In Claude Code, start the bridge:

```
/tlive
```

Now open your IM app on your phone and send a message to the bot. Claude Code will receive it, work on the task, and stream the response back to your phone — including tool usage and progress updates.

Use `/verbose 0|1` to control how much detail you see:
- `0` — final answer only
- `1` — terminal card with tool calls + results (default)

Other useful commands: `/runtime claude|codex` (switch provider), `/perm on|off` (permissions), `/effort low|high|max` (thinking depth), `/stop` (interrupt).

### Feature 3: Hook Approval

This one requires no extra steps — just use Claude Code normally. When Claude needs permission to run a tool (like executing a bash command), you'll get a notification on your phone with **Allow** and **Deny** buttons. Tap to respond, and Claude continues.

If the timeout expires, the default action is **deny** (safe by design).

## Troubleshooting

**Run automated diagnostics:**

```bash
tlive doctor
```

**Check logs:**

```bash
tlive logs 50
```

**Common issues:**

- **"Go Core not found"** — The binary didn't download correctly. Re-run `npm install -g tlive`.
- **"Bridge not starting"** — Check that `~/.tlive/config.env` exists and has valid credentials. Run `tlive doctor` for details.
- **"No IM messages"** — Verify your bot token is correct and the bot has been added to the right chat. See the platform-specific troubleshooting in the setup guides above.
- **Hook not firing** — Make sure you ran `tlive install skills`. Check `tlive hooks` for current hook status.

## Next Steps

- **Adjust verbose level:** `/verbose 1` for terminal card with tool calls and results
- **Pause hooks when at desk:** `tlive hooks pause` — auto-allows everything so you're not interrupted. `tlive hooks resume` to go back to IM approval.
- **Access web terminal from phone:** scan the QR code or use the Network URL printed when you start a session
- **Multiple sessions:** run several `tlive <cmd>` commands — they all show up in a single dashboard
- Read the full [README](../README.md) for all commands and architecture details
