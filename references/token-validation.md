# Token validation commands

After writing `~/.tlive/config.json`, you can either trust the built-in
probes (`tlive doctor` runs these automatically per enabled channel) or
hand-run the raw API calls below. Both do the same thing — pick whichever
is convenient when debugging.

The one-shot call: `tlive doctor` reports per-channel `✅ / ❌` with the
exact error surface. Use it first.

## Telegram

```bash
TOKEN=$(jq -r '.channels.telegram.token' ~/.tlive/config.json)
curl -s "https://api.telegram.org/bot${TOKEN}/getMe"
```

Expected: `"ok": true` with bot metadata. Not ok → token wrong or bot
deleted in BotFather.

## Discord

Discord doesn't expose a simple REST probe; gateway auth is the real
check. Run `tlive doctor` — it logs into the gateway for a split second
and reports the success / failure. Or eyeball the format:

```bash
TOKEN=$(jq -r '.channels.discord.token' ~/.tlive/config.json)
echo "$TOKEN" | grep -qP '^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' \
  && echo "format OK" || echo "format INVALID"
```

Format mismatch = token copied wrong from the Developer Portal.

## Feishu / Lark

```bash
APP_ID=$(jq -r '.channels.feishu.appId' ~/.tlive/config.json)
APP_SECRET=$(jq -r '.channels.feishu.appSecret' ~/.tlive/config.json)
curl -s -X POST \
  "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"${APP_ID}\",\"app_secret\":\"${APP_SECRET}\"}"
```

(Use `open.larksuite.com` for Lark.)

Expected: `"code": 0`. Any other code → App ID / App Secret mismatch, or
app not yet approved.

## Anthropic / OpenAI (agent side)

`tlive doctor` also probes:
- `claude` CLI is available and can obtain a model list.
- `codex` CLI is available.

If you use a proxy (e.g. ccswitch), the agent inherits
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` from your normal shell env —
tlive itself does not issue Anthropic API requests, the SDK does, so the
token validation path is Claude Code's own.
