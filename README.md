# tlive

[![npm version](https://img.shields.io/npm/v/tlive)](https://www.npmjs.com/package/tlive)
[![CI](https://github.com/y49/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/y49/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README_CN.md)

> **A vendor-neutral, self-hosted remote-approval + live-monitoring layer for AI coding agents.**
>
> Your `claude` / `codex` runs in your terminal as usual. tlive rides the
> **open hook mechanism** both vendors support to push approval cards and
> status to **Telegram / Feishu**, and serves a **web dashboard + real
> terminal** off your own machine — approve, reply, send a screenshot, or
> take over typing, from any device. Works **regardless of subscription or
> API key**; your session and data never leave your machine.

## 30 seconds to running

```bash
npm install -g tlive

tlive setup        # wizard: registers the tlive plugin with Claude Code's/
                    # Codex's own plugin manager (hooks, skill, /tlive:*
                    # commands), then IM credentials — or skip IM entirely
                    # and say "help me configure tlive" inside Claude/Codex
tlive start        # daemon up — prints web URLs + a QR code for your phone

tlive run claude   # (optional) wrap the session → live web terminal + preview card
```

Scan the QR once — the dashboard lists every session. When a tool call needs
approval, your IM gets a card with **Allow / Deny / Always-allow** buttons and
the web card lights up red.

## The two integration levels

| | hooks only (`claude`/`codex` as usual) | wrapped (`tlive run claude`/`codex`) |
|---|---|---|
| Approval cards (IM + web) | ✅ | ✅ |
| Stop-resume by IM reply | ✅ (reply window) | ✅ |
| Session card on dashboard | ✅ status / last message | ✅ + live terminal preview |
| Real web terminal (xterm) | — | ✅ multi-device, phone keys |
| IM text injection (quote-reply → typed into the pty) | — | ✅ |
| IM photo/file → agent | — | ✅ (downloaded, path injected) |
| Web paste/drop upload | — | ✅ |

Hooks-only always works — wrapping is pure addition. IM messages are tagged
`[⌨ label]` (wrapped, injectable) vs `[label]` (hooks-only) so you always know
which powers a session has.

## What's in the box

- **Approvals** — dual-channel on Claude Code: the `PermissionRequest` hook
  fires **in parallel with the local permission dialog** — both are live,
  first answer wins. Answer from IM buttons or the web card any time within
  24 hours; answer at the keyboard and the remote card resolves itself
  ("answered in terminal") within seconds. On Codex the `PreToolUse` hook
  gates serially with a 600s window (see Security model). Diff/command
  rendering, risky-pattern flags, secret masking. **"Always allow \<tool\>"**
  grants a per-tool pass (in-memory, cleared on restart) — on Claude Code it
  now answers the native dialog for you remotely; `/trust on|off` pauses
  approvals entirely. **Nothing is ever auto-denied**; an unanswered card
  simply leaves the local prompt in charge.
- **Resume** — on `Stop`, reply to the IM message (or the web reply box) and
  the session keeps going.
- **Daemon lazy-start** — hooks-only sessions no longer need a manual
  `tlive start` first: on `SessionStart` (and when `tlive run` launches), the daemon is
  started detached (non-blocking) if it isn't already up. Disable with
  `daemon.autoStart: false`; `tlive start` still works and is unaffected.
- **Failure alerts (Claude Code only)** — `PostToolUseFailure` (a tool call
  errored) and `StopFailure` (session-level error, e.g. rate-limit/billing)
  push a ❌ IM message. Pure side-channel, never affects approval decisions;
  Codex has no equivalent hooks so these aren't installed for it.
- **In-session welcome hint (Claude Code only)** — if IM isn't configured
  yet, `SessionStart` injects a one-line prompt into the session context
  nudging you to say "help me configure tlive"; it stops appearing once IM
  is set up. Not injected for Codex.
- **Web terminal** — `tlive run <cmd>` serves the pty at `/s/<id>`:
  xterm.js, multi-device with **last-input sizing** (whoever types owns the
  grid; everyone else sees a scaled view), screen rebuild for late joiners,
  soft-keyboard aware layout, view/input modes on touch, draggable key bar
  with Esc/Tab/⇧Tab/Ctrl-C/…, font size controls, copy-screen modal.
- **Dashboard** — `/` lists sessions: status badge, "stuck Nm" staleness,
  last assistant message, colored approval cards, live terminal previews,
  per-session mute, 📎 file upload, reply box.
- **Send anything to the agent** — IM quote-reply text, IM photos/files,
  terminal-page paste/drag-drop, dashboard 📎. All land as local paths in
  `~/.tlive/inbox` (auto-swept: 48 h age / 256 MB total) and are typed into
  the pty via bracketed paste.

## Install: plugins, not config writes

`tlive setup` (and `tlive setup --hooks-only`) no longer hand-edits
`~/.claude/settings.json` or `~/.codex/hooks.json` — it orchestrates each
vendor's **own plugin manager**:

- Claude Code: `claude plugin marketplace add <bundled dir>` then
  `claude plugin install tlive@tlive --scope user`.
- Codex (if `codex` is on `PATH`): `codex plugin marketplace add <bundled
  dir>` then `codex plugin add tlive@tlive`.

The plugin bundles the hooks (same 9 Claude Code events / 5 Codex events as
before), a `tlive` skill (usage, diagnostics, security model, under the
`/tlive:*` namespace), and Claude Code slash commands `/tlive:url` and
`/tlive:status`. The vendor **copies** the plugin into its own cache
(`~/.claude/plugins/cache` for Claude Code,
`$CODEX_HOME/plugins/cache/tlive/tlive/local/` for Codex) — after upgrading
`tlive` itself, re-run `tlive setup --hooks-only` to refresh that copy.

Ran a pre-plugin dev build that wrote hooks directly into vendor config?
Remove those entries by hand once (they'd double-fire otherwise) — see the
appendix in [docs/manual-hooks.md](docs/manual-hooks.md). tlive itself never
edits your vendor config files.

**Old vendor versions without a plugin CLI**: `tlive setup` detects this
(`claude plugin list` / `codex plugin marketplace add` failing) and prints a
pointer to the manual config appendix: [docs/manual-hooks.md](docs/manual-hooks.md)
— full `settings.json` hooks block and `hooks.json` you can paste in by
hand.

Uninstalling (`npm uninstall -g tlive`) best-effort removes the plugin via
each vendor's CLI and cleans up any leftover direct-write hooks; your
`~/.tlive` config and logs are preserved.

**Try it from GitHub first** (no npm publish needed): `claude plugin
marketplace add y49/tlive` then `claude plugin install tlive@tlive` pulls
the plugin (hooks/skill/commands) straight from the repo's root
`marketplace.json`. You still need the engine itself — `npm i -g tlive` —
for the daemon/CLI the hooks call into.

`tlive setup` asks **which vendor(s)** to install the plugin into when it
detects both `claude` and `codex` on `PATH`: `[1] Claude Code [2] Codex
[3] both (default)`. Plugin registration always runs before the IM
credential prompts, and the IM step is fully skippable — press Enter
through it and later say "help me configure tlive" inside Claude Code or
Codex — or, in Claude Code, run `/tlive:setup` — to have the AI walk you
through it interactively (Codex has no slash commands; use the phrase).

## Codex: hooks are trusted automatically

Installed events (via the plugin, `tlive hook --codex <event>`):
`PreToolUse` (approval), `Stop` (resume), `PostToolUse`,
`UserPromptSubmit`, `SessionStart`. Codex doesn't have `Notification` or
`SessionEnd` hooks, so those two aren't installed for it.

The catch: **Codex silently skips hooks it doesn't trust** — no error, no
prompt, they just never fire. `tlive setup` (and `--hooks-only`) handles
this for you right after installing the Codex plugin: it calls `codex
app-server`'s official read-only `hooks/list` RPC to read each tlive
hook's `currentHash`, writes the matching `[hooks.state]` entries into
`~/.codex/config.toml` (the same artifact an interactive `approve` in
Codex's own hooks review would produce), then calls `hooks/list` again to
self-check that every tlive hook now reports `trusted`. If that check
fails for any reason, it rolls the file back and falls back to the manual
path — it never touches hook entries other than tlive's own. `tlive
status` reports whether you're on `hooks installed but NOT trusted` or
`hooks installed and trusted`.

If auto-trust didn't go through (printed as a `⚠` line during setup), do
it once by hand: run `codex`, type `/hooks`, and approve tlive's hook —
the trust record lands in the same `~/.codex/config.toml`
`[hooks.state]` section.

If you'd rather skip both paths (needs root): add tlive's hook entries to
`/etc/codex/requirements.toml` under `[hooks]`. Codex treats hooks listed
there as pre-trusted "managed hooks" — see Codex's own docs for that
file's format; tlive doesn't write it for you.

## Why not the official remotes?

Official remotes (Claude Remote Control / Codex mobile / Channels) have
structural gaps tlive fills:

- **Cross-agent** — one setup for Claude Code and Codex.
- **API-key users** — official remotes exclude them; tlive doesn't care.
- **Self-hosted** — no vendor cloud in the path; a single token gates the web.
- **Feishu** — official channels don't cover it.

tlive deliberately does **not** try to be "vibe-code from your phone" — the
official remotes do that better. tlive is the approval / monitoring / interject
layer for sessions you already run.

## Security model

- **Web**: every HTTP/WS request requires the single token
  (`~/.tlive/web-token`, 0600). Default bind is `0.0.0.0` so your phone can
  reach it on the LAN — the token is the gate. Set `web.bind: "127.0.0.1"`
  to go loopback-only.
- **`web.publicUrl`** (optional, e.g. a tailscale/HTTPS reverse proxy): when
  set, IM messages carry a deep link **containing the token** — treat the
  chat as trusted, or leave it unset.
- **IM inbound**: fail-closed. Messages/button-taps are dropped unless they
  come from the configured chat; add `allowedSenders` for per-user hardening
  in group chats.
- **`/trust on` and "Always allow"** are power tools: they auto-approve.
  Both are in-memory and cleared on daemon restart. Prefer per-tool grants
  over `/trust`. Your own `permissions.deny` in Claude settings always wins —
  hooks cannot override it.
- **Fallback is silence**: no configured chat, timeout, or a daemon that's
  down → the hook emits `{}` and Claude prompts in your local terminal as if
  tlive weren't there. On Claude Code the local dialog is live the whole
  time anyway (parallel channels), so "fallback" just means the remote card
  goes quiet.
- **Codex's hook timeout fails open, not silent** — this is the one place
  Codex and Claude Code genuinely diverge. Claude Code's permission hook
  timing out leaves its local prompt in charge (safe, no default action).
  Codex's hook timing out lets the tool call **run** by default. tlive's
  mitigation: `~/.codex/hooks.json` sets `timeout: 600` on `PreToolUse`, and
  the shim self-deadlines at ~590s — comfortably inside that window — so
  tlive always answers `allow`/`deny`/`ask` before Codex's own fail-open can
  trigger. With nobody around to answer, it answers `ask` (Codex's native
  approval prompt), never an auto-allow. Residual risk: if the shim
  **process itself crashes** (not just times out), there's nothing left to
  answer, and Codex will fail open after 600s regardless — that gap can't be
  closed from a hook. (Why Codex can't get the parallel 24h channel: its
  permission hook blocks the native prompt — confirmed in Codex's source —
  so a long window would freeze the terminal. Want unlimited remote
  interaction with Codex? Wrap it: `tlive run codex` has no hook and no
  timeout — the web terminal and IM injection drive the session directly.)

## CLI

```
tlive setup            wizard + registers the vendor plugin(s) (idempotent); --hooks-only
tlive start | stop     daemon lifecycle (stop is idempotent)
tlive status           health, web URLs + QR, config paths
tlive logs [-f]        tail the daemon log
tlive run <cmd> …      wrap a process: local terminal + web terminal
tlive url              print the dashboard URL + QR (when a full-screen app hid the run banner)
tlive hook <event>     hook shim (called by Claude/Codex, not by you;
                        Codex passes --codex)
```

IM commands: `/perm on|off` (mute), `/trust on|off`, `/help`.
Quote-reply any session message to type into that session.

## Config (`~/.tlive/config.json`)

```jsonc
{
  "adapters": {
    "telegram": { "token": "…", "chatIdAllowList": ["123"] },
    "feishu":   { "appId": "…", "appSecret": "…", "chatId": "oc_…" }
  },
  "web": {
    "enabled": true,          // default true
    "bind": "0.0.0.0",        // default; use 127.0.0.1 for loopback-only
    "port": 7681,
    "publicUrl": "https://dev.example.ts.net"  // optional: IM deep links
  },
  "daemon": {
    "autoStart": true         // default true; false disables session-start lazy-start
  },
  "allowedSenders": [{ "channel": "telegram", "userId": "42" }]  // optional
}
```

## Tips

- **Persistent sessions**: tlive intentionally does not own sessions —
  `tlive run` dies with your terminal. Want detach/reattach? Combine:
  `tmux new -s work tlive run claude`. tmux keeps it alive; tlive keeps the
  web/IM layer on it.
- **Scroll on phone**: view mode converts touch-drag into wheel events —
  full-screen TUIs (claude) scroll their transcript exactly like a desktop
  mouse wheel. Use `Ctrl-R` on the key bar for claude's transcript mode.
- **Am I wrapped?** Wrapped processes see `TLIVE_SESSION=<id>` in their
  environment (like `$TMUX`); `tlive run` refuses to nest inside a wrapped
  session. Several wrapped sessions in the SAME directory are fine — each is
  its own card, and hook traffic from inside a wrapper is routed to that
  exact card via `TLIVE_SESSION`.
- **Windows**: supported by design (named pipes, ConPTY) but less battle-tested
  than Linux/macOS — issues welcome.

## Architecture

```
your `claude` / `codex` ──hooks──▶ tlive hook shim ──IPC──▶ daemon
tlive run <cmd> ─────── owns pty ── per-session socket ──▶ (bridge)
                                                            daemon ──▶ IM adapters (Telegram / Feishu)
                                                            daemon ──▶ web (token-gated): dashboard + /s/<id> terminal
```

- The **daemon** never owns sessions; it brokers approvals/resumes, fans out
  pty bytes, and serves the web.
- The **frozen surface** (contracts locked by `tests/contract/`) is documented
  in [KERNEL.md](KERNEL.md).

## Upgrading from v1.0

v1.0 drove sessions via the Agent SDK; v2.0 is the hook layer (see
`CHANGELOG.md`). Breaking, no migration: re-run `tlive setup`. v1.0 is
preserved at git tag `v1.0-sdk-bridge`.

## Development

```bash
git clone https://github.com/y49/tlive
cd tlive
pnpm install
npm run typecheck && npm test && npm run build
```

## License

MIT. See [LICENSE](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
