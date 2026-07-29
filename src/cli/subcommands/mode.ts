// src/cli/subcommands/mode.ts
//
// `tlive mode off|notify|full|all` — sets tlive's posture. Unlike the runtime
// toggles (/mute /trust /safe /desktop, which flip daemon state via IPC), `mode`
// is read by the hook SHIM straight from config.json on every event, so it must
// persist there. It takes effect immediately: the shim re-reads config on the
// next hook, no daemon restart and no new session needed. The IM `/mode` command
// writes the same file through the same writer.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MODES, MODE_DESC, writeMode } from '../../kernel/config/mode.js';
import type { ShimMode } from '../../kernel/hook/normalizer.js';

export function runMode(argv: string[]): void {
  const arg = argv[0] as ShimMode;
  if (!MODES.includes(arg)) {
    process.stderr.write(`Usage: tlive mode ${MODES.join('|')}\n`);
    process.exit(1);
    return; // unreachable in prod (process.exit throws); keeps the type checker + tests honest
  }
  const home = process.env.TLIVE_HOME ?? join(homedir(), '.tlive');
  const path = writeMode(home, arg);
  process.stdout.write(`tlive mode: ${MODE_DESC[arg]}\n(saved to ${path} — takes effect on the next hook event.)\n`);
}
