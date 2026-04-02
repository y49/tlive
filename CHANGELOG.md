# Changelog

All notable changes to this project will be documented in this file.

## [0.5.2](https://github.com/y49/tlive/compare/v0.5.1...v0.5.2) (2026-04-02)


### Bug Fixes

* **bridge:** bundle proxy agent packages instead of externalizing ([#10](https://github.com/y49/tlive/issues/10)) ([d4201aa](https://github.com/y49/tlive/commit/d4201aabaebf1bdf70899339f59e5049d7ba2cfb))

## [0.4.0] - 2026-03-30

### Added
- `/model <name>` command — switch model per session (works for both Claude and Codex)
- `/settings user|full|isolated` command — control Claude Code settings scope
- `TL_CLAUDE_SETTINGS` config — choose which Claude Code settings files to load (default: `user`)
- `TL_ANTHROPIC_API_KEY` / `OPENAI_API_KEY` support in config.env — non-TL_ vars injected into process.env
- `settingSources` integration — load user's `~/.claude/settings.json` for auth/model config
- Codex provider: effort mapping (`modelReasoningEffort`), env passthrough, auth error detection
- Codex adapter: full SDK type safety (replaced all `any` with SDK types), hidden tools filtering, `web_search`/`todo_list` support
- Codex session continuity — `thread_id` persisted via `query_result` for thread resumption
- Codex resume fallback — auto start new thread if resume fails (cross-provider session switch)
- `/runtime codex` pre-check — rejects switch if SDK not installed
- `/runtime` status shows availability of both providers
- Codex cost display — shows only duration when SDK reports 0 tokens

### Changed
- `/runtime` switch auto-creates new session (prevents cross-provider session ID conflicts)
- `/settings` is provider-aware: Claude shows settings sources, Codex shows current config summary
- Codex SDK loaded via dynamic `import()` (pure ESM compatibility fix)
- `renderDone()` trims response text before separator (prevents missing newline)

## [0.5.0] - 2026-04-03

### Added
- AskUserQuestion interactive support in IM — question cards with option buttons replace raw JSON permission cards
- Three interaction modes: button click, numeric reply, free text input
- Skip button returns allow + empty answers (Claude handles gracefully, no "Permission denied" error)
- Full support for both SDK mode and Hook mode (Go Core)
- Telegram, Discord, Feishu all supported with platform-specific formatting
- Go Core `HookResolution` extended with `updatedInput` for answer passthrough
- Hook handler passes `updatedInput` back to Claude Code
- Discord button row auto-splitting (max 5 per ActionRow)
- `editMessage` clears inline keyboard / buttons on all platforms
- Pending question detection bypasses "previous message still processing" guard

## [Unreleased]

### Added
- Terminal-style card display with rolling tool window, tree connectors, and inline permissions
- Zod-validated canonical event system replacing SSE string pipeline
- Multi-provider support: Codex (OpenAI) via `/runtime codex` command
- Graduated permission buttons: "Allow all edits", "Allow Bash(prefix *)", "Allow {tool}"
- Dynamic session whitelist — approved tools auto-allowed for the session
- 250ms conditional tool delay buffer — prevents fast tool call flicker
- Sensitive content redaction — API keys, tokens, passwords, private keys auto-redacted in IM
- AskUserQuestion support with inline option buttons
- `/runtime`, `/effort`, `/stop` IM commands
- `thinking_delta` event kind — Claude's thinking hidden from IM by default
- Hidden internal tools filtered from display (ToolSearch, TaskCreate, etc.)
- `parentToolUseId` for subagent nesting tracking
- `SessionMode` and `ProviderBackend` types for future multi-provider architecture

### Changed
- `StreamController` replaced by `TerminalCardRenderer` with rolling window
- `sseEvent()`/`parseSSE()` replaced by Zod `CanonicalEvent` typed stream
- `BridgeManager` refactored: extracted `SessionStateManager`, `PermissionCoordinator`, `CommandRouter`
- Permission buttons: Yes/No only → graduated tool-specific options
- Verbose levels: 0/1/2 → 0/1 (quiet / terminal card)

### Removed
- `StreamController` class
- `sse-utils.ts` (SSE string serialization)
- Verbose level 2 (detailed)
- "Always" permission button (use `/perm off` instead)

## [0.2.3] - 2026-03-25

### Changed
- Renamed GitHub repository from `TermLive` to `tlive` for consistency with npm package name

### Fixed
- Detect and replace empty tlive-core from failed downloads
- Use package.json version for Go Core download URL

## [0.2.1] - 2026-03-22

### Fixed
- Fail npm install when tlive-core download fails

### Changed
- Set npm publish access to public
- Use npm trusted publishing with provenance

## [0.2.0] - 2026-03-20

### Added
- **Feishu support** — WebSocket long connection, CardKit v2 interactive cards
- File upload support — images (vision) and text files from Telegram + Discord
- Permission timeout IM notification
- Consistent source labels for hook permissions and notifications
- DeliveryLayer with typed errors for smart retry decisions

### Fixed
- Prevent ambiguous permission resolution in multi-session mode
- Show URL, IP and QR code in client mode
- Skip stale notifications after Bridge restart
- Hooks only activate for tlive-managed sessions
- Prevent reply-to-hook from misrouting to Bridge LLM
- Filter WebSocket control messages in client mode
- Auto-rebind session after 30-minute inactivity
- Windows cross-compile (extract SIGWINCH handler to platform files)

### Changed
- Render Telegram messages as HTML with proper formatting
- Replace `any` types with proper interfaces
- Increase hook notification summary limit from 300 to 3000 chars

## [0.1.0] - 2026-03-15

### Added
- **Web Terminal** — wrap any command with `tlive <cmd>`, multi-session dashboard
- **IM Bridge** — chat with Claude Code from Telegram and Discord
- **Hook Approval** — approve Claude Code permissions from your phone
- Go Core with PTY management, WebSocket, HTTP API
- Node.js Bridge with Agent SDK, streaming responses, cost tracking
- QR code display for mobile access
- Token-based authentication
- Smart idle detection with output classification
- Windows ConPTY support
- Docker Compose support
