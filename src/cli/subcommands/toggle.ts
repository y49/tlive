// src/cli/subcommands/toggle.ts
//
// At-the-terminal entrance to the daemon's runtime toggles — the same state
// the IM commands (/perm /trust /safe) flip — plus `desktop`, which is
// CLI-only (machine-local toast, no IM command). Direct IPC, no AI in
// the loop (the CC plugin's slash commands are prompts by design; this is
// the one-liner they can shell out to).
import { request } from '../../kernel/ipc/client.js';

export type ToggleKey = 'perm' | 'trust' | 'safe' | 'desktop';

const CONFIRM: Record<ToggleKey, [on: string, off: string]> = {
  perm: ['Notifications on', 'Notifications muted'],
  trust: ['Approvals paused (everything auto-allowed)', 'Approvals resumed'],
  safe: [
    'Safe auto-approve ON — routine ops run without a card; dangerous ops, MCP/unknown tools, and questions still ask.',
    'Safe auto-approve OFF — back to asking for everything except read-only tools.',
  ],
  desktop: ['Desktop notifications on', 'Desktop notifications off (IM cards unaffected)'],
};

export async function runToggle(key: ToggleKey, argv: string[]): Promise<void> {
  const arg = argv[0];
  if (arg !== 'on' && arg !== 'off') {
    process.stderr.write(`Usage: tlive ${key} on|off\n`);
    process.exit(1);
  }
  const enabled = arg === 'on';
  try {
    const r = await request({ kind: 'daemon.set', key, enabled }, { timeoutMs: 4000 });
    if (r.kind !== 'ack') throw new Error(r.kind === 'error' ? r.message : `unexpected reply: ${r.kind}`);
    process.stdout.write(`${CONFIRM[key][enabled ? 0 : 1]}\n`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      process.stderr.write('tlive daemon is not running — start it with: tlive start\n');
    } else if (/unhandled request/.test(err.message)) {
      process.stderr.write('The running daemon predates this command — restart it: tlive stop; tlive start\n');
    } else {
      process.stderr.write(`tlive ${key}: ${err.message}\n`);
    }
    process.exit(1);
  }
}
