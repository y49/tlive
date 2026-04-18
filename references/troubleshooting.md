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

## Telegram long-polling unstable (ECONNRESET / socket hang up)

**Symptoms**: Bridge logs repeatedly show `getUpdates` errors such as `ECONNRESET` or `socket hang up`.

**Steps**:
1. Ensure only one bot instance is running
   - Stop duplicate bridge sessions and restart once: `tlive stop && tlive start`
2. Lower Telegram poll timeout
   - In `~/.tlive/config.env`, set `TL_TG_POLL_TIMEOUT=10`
   - Restart bridge: `tlive stop && tlive start`
3. If your region/network needs a proxy, set `TL_TG_PROXY` (or global `TL_PROXY`)
4. Re-check recent logs: `tlive logs 100`

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

## High memory usage

**Symptoms**: Bridge process consumes increasing memory over time.

**Steps**:
1. Check status: `/tlive status`
2. Restart: `/tlive stop` then `/tlive start`
3. Check for large conversation buffers in logs
