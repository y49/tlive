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

| | hooks/companion only (`claude`/`codex` as usual) | wrapped (`tlive run claude`/`codex`) |
|---|---|---|
| Approval cards (IM + web) | ✅ | ✅ |
| Stop-resume by IM reply | ✅ (reply window) | ✅ |
| Session card on dashboard | ✅ status / last message | ✅ + live terminal preview |
| Real web terminal (xterm) | — | ✅ multi-device, phone keys |
| IM text injection (quote-reply → typed into the pty) | — | ✅ |
| IM photo/file → agent | — | ✅ (downloaded, path injected) |
| Web paste/drop upload | — | ✅ |

Hooks-only always works — wrapping is pure addition. IM messages carry a
`label · ` prefix (the session's directory) but no longer mark wrapped vs.
hooks-only visually — the continue card's own "Reply to continue" line makes
the distinction moot for what you actually do.

## What's in the box

- **Approvals** — dual-channel on Claude Code: the `PermissionRequest` hook
  fires **in parallel with the local permission dialog** — both are live,
  first answer wins. A card isn't sent immediately: `approvals.approvalGraceSec`
  (default 10s, `0` disables) holds it first, so answering at the keyboard
  right away means the IM card is never sent at all. Answer from IM buttons
  or the web card any time within 24 hours; answer at the keyboard and the
  remote card resolves itself ("answered in terminal") within seconds. On
  Codex, tlive spawns/adopts a `codex app-server` companion process and
  Codex TUIs auto-attach to it — the remote card and the native prompt race
  the same way, with no window to configure (see Security model). Diff/command
  rendering, risky-pattern flags, secret masking. **"Always allow \<tool\>"**
  grants a per-tool pass (in-memory, cleared on restart) — on Claude Code it
  now answers the native dialog for you remotely; `/trust on|off` pauses
  approvals entirely. **Nothing is ever auto-denied**; an unanswered card
  simply leaves the local prompt in charge. Telegram cards keep formatting
  restrained: bold titles, plain-text buttons, blank-line breathing room, and
  the only emoji left anywhere is `⚠️` on a risky-command flag or an
  error-level notification; expandable quotes still handle long diffs/
  commands — use a reasonably recent Telegram app for best rendering.
- **Answer `AskUserQuestion` from IM (Claude Code only)** — CC fires a
  `PermissionRequest` for its own question tool; tlive relays it as a
  single-select or multi-select card (checkboxes, a live `Submit (N)` count,
  `Skip`) instead of Allow/Deny. The local question prompt still renders in
  parallel and always wins a race, so an answer given at the keyboard is
  never overridden — `Skip` just passes the tool through so the local prompt
  can be answered instead; it is not an auto-approval of anything. Codex has
  no equivalent concept.
- **Resume** — on `Stop`, reply to the IM message (or the web reply box) and
  the session keeps going. The card's excerpt sits inside a collapsed
  expandable quote (headings, lists, tables and code all survive the
  conversion — nothing is cut mid-word or mid-fence); while that card is
  still pending, the 60-second idle "waiting for your input" notification is
  suppressed instead of piling a second message on top of it.
- **Daemon lazy-start** — hooks-only sessions no longer need a manual
  `tlive start` first: on `SessionStart` (and when `tlive run` launches), the daemon is
  started detached (non-blocking) if it isn't already up. Disable with
  `daemon.autoStart: false`; `tlive start` still works and is unaffected.
- **Failure alerts (Claude Code only)** — `PostToolUseFailure` (a tool call
  errored) and `StopFailure` (session-level error, e.g. rate-limit/billing)
  push a `⚠️`-prefixed IM message. Pure side-channel, never affects approval
  decisions; Codex has no equivalent hooks, so this only fires for Claude Code.
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

The Claude Code plugin bundles the 9 hook events, a `tlive` skill (usage,
diagnostics, security model, under the `/tlive:*` namespace), and slash
commands `/tlive:url` and `/tlive:status`. The Codex plugin ships only the
skill — Codex has no hooks and needs none; its integration is the
app-server companion (see below). The vendor **copies** the plugin into its
own cache (`~/.claude/plugins/cache` for Claude Code,
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

## Codex: the app-server companion

Codex has no hooks and no trust step — the entire Claude-style hooks/trust
dance above doesn't apply. Instead, `tlive` takes custody of a `codex
app-server --listen unix://…` process: it adopts one already listening on
tlive's socket path, or spawns and owns one (with respawn/backoff) if none
is there. Any `codex` TUI you run **auto-attaches** to that socket — this
is a Codex feature, not something tlive configures per-session.

Over that RPC connection tlive subscribes to Codex's own thread/turn
events and drives approvals through `ServerRequest`: when Codex asks for a
permission decision, tlive broadcasts the same request to IM/web and to
the native TUI prompt simultaneously — **first answer wins**, exactly like
Claude Code's parallel channel. There is no approval window to configure:
the native prompt is never blocked waiting on tlive, so there's nothing
that can time out.

If the companion can't be reached (Codex not installed, respawn exhausted
its backoff, or you're on win32 where `codex app-server` isn't wired up
yet), `tlive status` says so plainly (`codex: app-server companion
unreachable — approvals local-only`) and Codex just runs with its normal
local approval flow — no IM/web card, no crash, no degraded behavior
beyond losing the remote channel.

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
  to go loopback-only. **Cards never carry a link to the dashboard.** The
  deep link that used to ship there carried the token itself — full control
  over every session — and sending it to IM would park that token on the
  messaging provider's servers permanently. Open the dashboard yourself (over
  your own tailscale/HTTPS reverse proxy if you need it off the LAN); IM is
  push, web is pull.
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
- **Codex approvals are fail-safe by construction** — the native prompt is
  never blocked waiting on tlive (no window, nothing to time out); if the
  companion is unreachable Codex just runs its own local approval flow and
  `tlive status` reports `codex: app-server companion unreachable —
  approvals local-only`. When the companion is up, the remote card and the
  native prompt race — first answer wins, same semantics as Claude Code's
  parallel channel.

## CLI

```
tlive setup            wizard + registers the vendor plugin(s) (idempotent); --hooks-only
tlive start | stop     daemon lifecycle (stop is idempotent)
tlive status           health, web URLs + QR, config paths
tlive logs [-f]        tail the daemon log
tlive run <cmd> …      wrap a process: local terminal + web terminal
tlive url              print the dashboard URL + QR (when a full-screen app hid the run banner)
tlive hook <event>     hook shim (called by Claude Code, not by you;
                        Codex has no hooks — see the app-server companion)
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
    "port": 7681
  },
  "daemon": {
    "autoStart": true         // default true; false disables session-start lazy-start
  },
  "approvals": {
    // remote-approval window in seconds, Claude Code only: its permission
    // hook runs parallel to the local dialog, so a long window costs
    // nothing. Codex has no window — see the app-server companion section.
    "claudeWindowSec": 1800,  // default 30min, max 86200 (~24h)
    // grace period before an approval card is sent — answering at the
    // keyboard within this window means it's never sent at all
    "approvalGraceSec": 10    // default 10s, 0 disables
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
your `claude` ────────── hooks ──▶ tlive hook shim ──IPC──▶ daemon
your `codex` ─────────── rpc ───▶ tlive app-server companion ──▶ daemon
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
