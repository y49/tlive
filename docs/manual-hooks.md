# Manual hook install (no plugin CLI)

> Normal path: `tlive setup` (or `tlive setup --hooks-only`) registers
> tlive's plugin with `claude`'s / `codex`'s own plugin manager — see the
> "Install: plugins, not config writes" section in [README.md](../README.md).
> This page is the fallback for a vendor CLI too old to have `claude plugin`
> / `codex plugin` subcommands: paste the blocks below into the vendor's
> config by hand. Content mirrors
> `plugins/claude/plugins/tlive/hooks/hooks.json` and
> `plugins/codex/plugins/tlive/hooks/hooks.json` in the tlive repo — if a
> future tlive release changes those files, re-copy from there.

手动路径仅用于厂商 CLI 太老、没有 `claude plugin` / `codex plugin` 子命令
的情况。正常路径请用 `tlive setup`(见 README「Install: plugins, not
config writes」一节)。

## Claude Code — `~/.claude/settings.json`

Merge the `hooks` block below into your existing `~/.claude/settings.json`
(create the file with `{}` if it doesn't exist yet; if you already have
`hooks` entries for other tools, merge event-by-event instead of
overwriting).

```json
{
  "hooks": {
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook pre-tool-use", "timeout": 600 }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "tlive hook stop", "timeout": 180 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook post-tool-use" }] }],
    "Notification":       [{ "hooks": [{ "type": "command", "command": "tlive hook notification" }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "tlive hook user-prompt-submit" }] }],
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "tlive hook session-start" }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "tlive hook session-end" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook post-tool-use-failure" }] }],
    "StopFailure":        [{ "hooks": [{ "type": "command", "command": "tlive hook stop-failure" }] }]
  }
}
```

`tlive hook <event>` must resolve on `PATH` (the same binary `tlive setup`
installs). No further action needed on the Claude Code side — hooks fire as
soon as `settings.json` is saved.

You won't get the `tlive` skill or the `/tlive:url` / `/tlive:status` slash
commands this way (those only ship inside the plugin) — `tlive status` and
`tlive url` from the CLI cover the same ground.

## Codex — `~/.codex/hooks.json`

Write (or merge into) `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook --codex pre-tool-use", "timeout": 600, "async": false }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "tlive hook --codex stop", "timeout": 180, "async": false }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook --codex post-tool-use", "async": false }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "tlive hook --codex user-prompt-submit", "async": false }] }],
    "SessionStart":     [{ "matcher": "startup|resume|clear|compact", "hooks": [{ "type": "command", "command": "tlive hook --codex session-start", "async": false }] }]
  }
}
```

Codex has no `Notification` or `SessionEnd` hook events, so those two
aren't part of the set (unlike Claude Code's 9).

### Codex trust (required either way — plugin or manual)

Codex silently no-ops hooks it doesn't trust — no error, no prompt, they
just never fire, plugin-installed or hand-written alike:

1. Run `codex` interactively once.
2. In its hooks review, approve tlive's hook — the trust record lands in
   `~/.codex/config.toml` under `[hooks.state]`.
3. `tlive status` reads that file and reports `hooks installed but NOT
   trusted` vs `hooks installed and trusted`.

To skip the interactive review (needs root): add tlive's hook entries to
`/etc/codex/requirements.toml` under `[hooks]` — Codex treats hooks listed
there as pre-trusted "managed hooks". See Codex's own docs for that file's
format; tlive doesn't write it for you.

## Upgrading later

If you ever get a newer `claude`/`codex` with a plugin CLI, prefer
switching to the plugin path: run `tlive setup --hooks-only` — it detects
the vendor plugin CLI and installs the plugin instead (the plugin also
strips these hand-written entries so they don't double-fire). Until then,
re-copy the blocks above whenever a tlive release changes the hook set (see
the note at the top of this file).
