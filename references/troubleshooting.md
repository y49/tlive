# Troubleshooting

## Bridge won't start

**Symptoms**: `tlive start` or `/tlive start` fails, or daemon exits immediately.

**Steps**:
1. Run `/tlive doctor` to identify the issue
2. Check Node.js >= 22: `node --version`
3. Check Claude Code CLI: `claude --version`
4. Verify config exists: `ls -la ~/.tlive/config.env`
5. Check logs: `/tlive logs`

**Common causes**:
- Missing or invalid config.env → run `/tlive setup`
- Node.js not found or wrong version → install Node.js >= 22
- Port conflict → check if another instance is running with `/tlive status`
- Stale PID file → `rm ~/.tlive/runtime/bridge.pid` and retry

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:
1. Verify token is valid: `/tlive doctor`
2. Check allowed user IDs in config — only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited with message read permissions
5. For Feishu: confirm app is approved and event subscriptions are configured
6. Check logs for incoming messages: `/tlive logs 200`

## Hook approval not working

**Symptoms**: Claude Code runs without sending permission requests to phone.

**Steps**:
1. Verify hooks are configured in `~/.claude/settings.json`
2. Check hook scripts exist: `ls -la ~/.tlive/bin/hook-handler.sh`
3. Check Go Core is running: `curl -sf http://localhost:4590/api/status`
4. Check hooks aren't paused: `tlive hooks`
5. Test hook script manually: `echo '{}' | ~/.tlive/bin/hook-handler.sh`

## Streaming not working

**Symptoms**: Bot sends final response only, no real-time updates.

**Steps**:
1. Check verbose level is 1: send `/verbose 1` in IM
2. For Feishu: verify `editMessage` card patching works (check logs for API errors)
3. Check delivery rate limiting — rapid edits may be throttled

## Wrong working directory in IM Bridge

**Symptoms**: The IM Bridge says it is in `/`, cannot safely read repository files, or fails to resolve relative project paths after `/new`.

**Steps**:
1. Check startup `defaultWorkdir` logs
   - Confirm startup logs show the resolved `defaultWorkdir`, current `process.cwd()`, and whether the source was `TL_DEFAULT_WORKDIR` or fallback `process.cwd()`.
   - If `defaultWorkdir` is `/`, non-absolute, missing, or not a directory, fix startup configuration first.
2. Check router session bootstrap logs
   - For a fresh chat or after `/new`, confirm logs show binding creation or reuse, session seeding, and the stored session `workingDirectory`.
   - This verifies the IM chat was attached to the expected bridge session.
3. Check SDKEngine cwd-selection logs
   - Confirm the engine logs show stored session cwd, `defaultWorkdir`, final effective cwd, source of selection, and whether healing occurred.
   - This is the authoritative per-message cwd decision.
4. Reproduce with a safe read-only prompt
   - Restart the bridge.
   - In Telegram, run `/new`.
   - Send: `請讀取 README.md 第一行，不要修改任何檔案。`
   - Confirm the reply matches the repository file content.
5. Inspect logs if the issue persists
   - Run: `tlive logs 100`
   - Determine whether `/` came from startup configuration, session persistence, or execution-time fallback/healing.

## High memory usage

**Steps**:
1. Check status: `/tlive status`
2. Restart: `/tlive stop` then `/tlive start`
3. Check for large conversation buffers in logs
