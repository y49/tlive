# Platform Setup — pointer

The per-platform bot setup flows live in `docs/`:

- [docs/setup-telegram.md](../docs/setup-telegram.md) — Telegram bot, chat
  IDs, forum-group topics, webhook vs long-polling.
- [docs/setup-discord.md](../docs/setup-discord.md) — Discord bot, gateway
  intents, slash command registration, thread-per-session.
- [docs/setup-feishu.md](../docs/setup-feishu.md) — Feishu / Lark custom
  app, scopes, WebSocket events, version publish + admin approval.

Each guide ends with the JSON block that goes under
`channels.<platform>` in `~/.tlive/config.json`. The `tlive setup` wizard
is the recommended path; hand-editing is fine once you know the schema
(`src/config/schema.ts`).

For the `tlive setup` flow itself, see
[docs/getting-started.md](../docs/getting-started.md).

For live-environment token validation, see
[references/token-validation.md](./token-validation.md).
