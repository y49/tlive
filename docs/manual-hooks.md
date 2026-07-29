# Manual hook install (no plugin CLI)

> Normal path: `tlive setup` (or `tlive setup --hooks-only`) registers
> tlive's plugin with `claude`'s own plugin manager — see the
> "Install: plugins, not config writes" section in [README.md](../README.md).
> This page is the fallback for a Claude Code CLI too old to have `claude
> plugin` subcommands: paste the block below into `~/.claude/settings.json`
> by hand. Content mirrors `plugins/claude/plugins/tlive/hooks/hooks.json`
> in the tlive repo — if a future tlive release changes that file, re-copy
> from there. Codex needs no manual hook setup at all (see below).

手动路径仅用于 Claude Code CLI 太老、没有 `claude plugin` 子命令的情况。
正常路径请用 `tlive setup`(见 README「Install: plugins, not config
writes」一节)。Codex 不需要手动配置任何 hook(见下文)。

## Claude Code — `~/.claude/settings.json`

Merge the `hooks` block below into your existing `~/.claude/settings.json`
(create the file with `{}` if it doesn't exist yet; if you already have
`hooks` entries for other tools, merge event-by-event instead of
overwriting).

```json
{
  "hooks": {
    "PermissionRequest":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook permission-request", "timeout": 86400 }] }],
    "PermissionDenied":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook permission-denied" }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "tlive hook stop", "async": true, "asyncRewake": true, "timeout": 1860 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook post-tool-use" }] }],
    "Notification":       [{ "hooks": [{ "type": "command", "command": "tlive hook notification" }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "tlive hook user-prompt-submit" }] }],
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "tlive hook session-start" }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "tlive hook session-end" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "tlive hook post-tool-use-failure" }] }],
    "StopFailure":        [{ "hooks": [{ "type": "command", "command": "tlive hook stop-failure" }] }],
    "SubagentStart":      [{ "hooks": [{ "type": "command", "command": "tlive hook subagent-start" }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "tlive hook subagent-stop" }] }]
  }
}
```

Approval gating only happens in `mode: full` or `mode: all` (remote approval —
opt-in via `tlive mode full`, or `tlive mode all` to also hold sub-agent
approvals); tlive's default posture is `notify`, where the shim passes every
`PermissionRequest` through untouched and prompts stay 100% local. When it is
on, approval gating on Claude Code rides `PermissionRequest`, which runs in
PARALLEL with the local permission dialog for a main-session request: both are
live, first answer wins, and a local answer releases the remote card within
seconds. (A held sub-agent request under `all` is the one exception — Claude
Code decides whether to build its dialog only after the hook returns, so there
is no local dialog to race until the window ends.) The 24-hour `timeout` is
what keeps the remote card answerable while you're away from the keyboard.

`tlive hook <event>` must resolve on `PATH` (the same binary `tlive setup`
installs). No further action needed on the Claude Code side — hooks fire as
soon as `settings.json` is saved.

You won't get the `tlive` skill or the `/tlive:url` / `/tlive:status` slash
commands this way (those only ship inside the plugin) — `tlive status` and
`tlive url` from the CLI cover the same ground.

## Codex — no hooks, no trust

Codex needs neither a hooks config nor a trust step. Integration rides the
app-server companion instead: `tlive` spawns `codex app-server --listen
unix://…` (adopting an existing one if it finds it), and Codex TUIs
auto-attach to that socket. Approvals and monitoring flow over that RPC
connection — there is nothing to write into `~/.codex/hooks.json` and
nothing to approve in a hooks review.

If you have an old dev-build `~/.codex/hooks.json` from before this
integration existed, delete the file — it's inert now and only wastes a
process-startup no-op.

## Upgrading later

If you ever get a newer `claude` with a plugin CLI, prefer
switching to the plugin path: run `tlive setup --hooks-only` — it detects
the vendor plugin CLI and installs the plugin instead. Then remove the
hand-written blocks above yourself (tlive never edits vendor config, so
they would double-fire alongside the plugin's hooks). Until then,
re-copy the blocks above whenever a tlive release changes the hook set (see
the note at the top of this file).

## Upgrading from a pre-plugin dev build

Early development builds wrote hook entries directly into vendor config.
tlive no longer touches those files and does not auto-clean old entries —
if you ran such a build, remove them once by hand (otherwise every hook
fires twice):

- `~/.claude/settings.json` — delete the hook groups tagged `"_tlive": true`.
- `~/.codex/hooks.json` — delete the groups whose command starts with
  `tlive hook`; delete the file if that leaves it empty.
- `~/.claude/commands/tlive.md` and `~/.claude/skills/tlive/` — the old
  standalone slash command / skill (`tlive install skills` era; that CLI
  command no longer exists). If present alongside the plugin you'll see two
  `/tlive` entries in the `/` menu — delete the standalone copies.
