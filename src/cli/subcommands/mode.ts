// src/cli/subcommands/mode.ts
//
// `tlive mode off|notify|full` — sets tlive's posture. Unlike the runtime toggles
// (/mute /trust /safe /desktop, which flip daemon state via IPC), `mode` is read by
// the hook SHIM straight from config.json on every event, so it must persist there.
// It takes effect immediately: the shim re-reads config on the next hook, no daemon
// restart and no new session needed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODES = ['off', 'notify', 'full'] as const;
type Mode = (typeof MODES)[number];

const BLURB: Record<Mode, string> = {
  off: 'off — tlive hooks are no-ops: no approval gating, no notifications, no monitoring.',
  notify: 'notify — tlive observes + notifies (IM / dashboard) but NEVER holds an approval; every approval stays fully native (local terminal dialog, or CC auto-deny when headless).',
  full: 'full — remote approval ON: tlive holds tool approvals so you can answer them from IM / desktop / dashboard.',
};

export function runMode(argv: string[]): void {
  const arg = argv[0];
  if (!MODES.includes(arg as Mode)) {
    process.stderr.write(`Usage: tlive mode ${MODES.join('|')}\n`);
    process.exit(1);
    return; // unreachable in prod (process.exit throws); keeps the type checker + tests honest
  }
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const path = join(home, 'config.json');
  // Read the RAW file (not loadConfig, which allowlists `web`) so every other
  // field round-trips untouched — this command only flips `mode`.
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf-8')); } catch { cfg = {}; }
  } else {
    mkdirSync(home, { recursive: true });
  }
  cfg.mode = arg;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  process.stdout.write(`tlive mode: ${BLURB[arg as Mode]}\n(saved to ${path} — takes effect on the next hook event.)\n`);
}
