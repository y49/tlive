# Getting Started with tlive v1.0

This guide takes you from zero to a working tlive setup. By the end you'll
have the daemon running, at least one IM bot connected, and a Claude Code /
Codex session driven from your phone.

**Changed in v1.0:** tlive is no longer a PTY wrapper or a web-terminal. It
is an MCP-native agent fabric. The legacy agent-wrapper subcommands, web
terminal, and hook scripts are all gone. Instead the daemon owns an
SDK-backed runtime that you talk to through IM or through plain `claude` /
`codex` running locally as an MCP client.

## Prerequisites

- **Node.js 20+** and npm (Node 22 recommended).
- **Claude Code** or **Codex** installed locally — needed for Companion mode
  and for locally-resumed sessions after `/handoff-to-me`.
- An IM account on one of **Telegram**, **Discord**, or **Feishu**. You can
  enable any combination.

## Install

```bash
npm install -g tlive
tlive version
```

## Configure — `tlive setup`

```bash
tlive setup
```

The wizard is git-aware: it sniffs `git remote` in the current directory and
proposes a workspace named after the repo. It writes (or migrates) the
config at:

```text
~/.tlive/config.json
```

**Changed in v1.0:** config is JSON, not `config.env`. If the wizard finds a
v0.x `config.env`, it migrates it in place and backs the old file up as
`~/.tlive/config.v0-backup.env`. The schema is validated by
`src/config/schema.ts` (Zod) at daemon boot.

Config shape (see also `config.env.example` for a commented reference and
[README.md](../README.md#config) for the full schema):

```json
{
  "version": "1",
  "workspaces": [
    { "id": "ws-…", "name": "my-project", "workdir": "/home/me/proj" }
  ],
  "channels": {
    "telegram": { "token": "…" }
  },
  "permissions": { "allowedUsers": ["…"] }
}
```

Secure the file:

```bash
chmod 600 ~/.tlive/config.json
```

## Connect a bot

Pick your platform and follow the detailed guide:

- [Telegram](setup-telegram.md) — fastest, ~5 min
- [Discord](setup-discord.md) — ~10 min, needs server admin
- [Feishu / Lark](setup-feishu.md) — ~15 min, needs workspace admin approval

Each guide ends with the JSON block to paste under `channels.<platform>` in
`~/.tlive/config.json`.

## Install agent integrations

```bash
tlive install-integrations        # claude + codex + MCP entries
```

Or just one side:

```bash
tlive install-integrations claude
tlive install-integrations codex
```

This:

- Copies `src/skills/claude/` → `~/.claude/skills/tlive/` (the `/tlive` skill
  for handoff operations).
- Adds `mcpServers.tlive` to `~/.claude/settings.json` pointing at
  `tlive mcp` (stdio server).
- Copies `src/skills/codex/tlive.md` → Codex's prompts directory.
- Prints a note about Companion mode's optional
  `permissionPromptToolName: "mcp__tlive__approve"` setting.

## Start the daemon

```bash
tlive start
tlive status
tlive doctor
```

`tlive doctor` runs structured health checks (config schema, platform
credentials, daemon socket, MCP boot, warm pool). A green doctor run is the
preflight for release and for the [smoke test](smoke-test.md).

---

## The 3 modes

Any combination is supported against the same daemon.

### Mode A — Daemon mode (IM is primary)

The daemon owns the SDK runtime. IM is the only interactive surface.

**Example flow**

1. Open Telegram and DM `@yourbot`.
2. Send: `help me refactor the auth module`.
3. Observe in the chat:
   - Your message gets a 👁️ reaction within ~100ms.
   - A **session header** pins: `📁 my-project · 🤖 sonnet-4 · ⚡️ warm · 💰 $0.00`.
   - An **activity sticky** evolves: `🧠 thinking…` → `🔧 Read src/auth/cookies.ts` → `🔧 Grep passport-*` → streaming reply.
   - When Claude wants to run `Bash(npm test)` a **permission card** arrives
     with Allow / Deny / Always / Learn buttons.
4. Tap **Allow**. Claude continues. The sticky updates to `✅ done · 12.4s · $0.031`.
5. Bump the model mid-turn: send `/model opus`. The header badge switches.

Typical user: mobile-first developer; team group chat with Claude as a
member; "I never open a terminal for coding tasks."

### Mode B — Companion mode (local CLI + MCP)

You run plain `claude` locally; tlive only hosts its MCP server. Permissions
are routed to IM via `permissionPromptToolName`.

**Setup.** After `tlive install-integrations claude`, edit
`~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "tlive": { "command": "tlive", "args": ["mcp"] }
  },
  "permissionPromptToolName": "mcp__tlive__approve"
}
```

**Example flow**

1. In a terminal: `claude` (plain, no tlive wrapper).
2. Ask Claude to run tests: `npm test please`.
3. Claude wants to run `Bash(npm test)`. Because
   `permissionPromptToolName` is set, the SDK routes the prompt through the
   `tlive` MCP server instead of showing the local TUI prompt.
4. **Your phone buzzes** — a permission card arrives in IM with the Bash
   block, the "why" summary, and Allow/Deny buttons.
5. You tap **Allow**. The MCP tool returns `{allow: true}` to the SDK, and
   your local `claude` unblocks and runs the command.

The remote session also appears in `/sessions` marked "💻 remote from local
claude" — you can `/cost`, `/search`, `/export` against it exactly like a
daemon-hosted one.

Typical user: terminal-native developer who wants approvals on phone when
stepping away.

### Mode C — Handoff (seamless between A and B)

One jsonl, one writer at a time — enforced by `workspace.activeSessionId`.

**Example flow (Daemon → local)**

1. You've been driving a session in IM on your phone. Alias: `a1b2c3d4`.
2. You arrive at your laptop. From the IM chat: `/handoff-to-me`.
3. Daemon stops the runtime, releases the jsonl lock, posts:
   `📲 handed off to you — continue with: claude --resume a1b2c3d4`.
4. Locally: `claude --resume a1b2c3d4`. Claude picks up exactly where IM
   left off (system prompt, permissions, working dir, conversation state).

**Example flow (local → Daemon)**

From inside a running local `claude`:

```text
/tlive takeback a1b2c3d4
```

The skill POSTs to the daemon's socket, the daemon resumes the SDK runtime,
local claude exits cleanly, and IM takes over rendering.

---

## Troubleshooting basics

- **`config not found`** → run `tlive setup`. First-run detection creates
  `~/.tlive/config.json`.
- **`daemon unreachable`** → `tlive start`. If it says "already running"
  but `tlive status` disagrees, remove the stale socket:
  `rm ~/.tlive/daemon.sock` and retry.
- **Bot token looks fine but no messages arrive** → `tlive doctor` runs a
  live per-platform probe (`getMe` for Telegram, gateway auth for Discord,
  `tenant_access_token` for Feishu).
- **Permission card buttons do nothing** → check
  `tlive daemon-logs --follow` for CallbackRouter errors. Usually a stale
  card from before a daemon restart — resend the triggering message.
- **`/sessions` is empty** → sessions live in the native agent directories
  (`~/.claude/projects/<slug>/*.jsonl`, `~/.codex/sessions/*.jsonl`). The
  `SessionDiscovery` picks them up; if it can't, check the `workdir` in
  your workspace points at the right directory.

Full troubleshooting table: [references/troubleshooting.md](../references/troubleshooting.md).

## Next steps

- [45-command IM reference](commands.md)
- [Manual smoke test](smoke-test.md) — 15-step release verification
- Platform setup guides: [Telegram](setup-telegram.md) · [Discord](setup-discord.md) · [Feishu](setup-feishu.md)
- Back to [README.md](../README.md) for architecture and the full CLI surface.
