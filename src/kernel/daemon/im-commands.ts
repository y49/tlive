// src/kernel/daemon/im-commands.ts
//
// M1 command set: /use, /perm, /help only.
// Session-ownership commands (/new /sessions /resume /handback /stop /kill /model /runtime)
// are removed — sessions are user-owned interactive shells, not daemon-driven.

export type ImCommand =
  | { kind: 'use'; workspaceId: string }
  | { kind: 'perm'; enabled: boolean }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

export function parseImCommand(text: string): ImCommand | null {
  if (!text.startsWith('/')) return null;
  const trimmed = text.trim();
  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  switch (cmd) {
    case 'use': return args[0] ? { kind: 'use', workspaceId: args[0] } : { kind: 'unknown', name: cmd };
    case 'perm':
      if (args[0] === 'on') return { kind: 'perm', enabled: true };
      if (args[0] === 'off') return { kind: 'perm', enabled: false };
      return { kind: 'unknown', name: cmd };
    case 'help': return { kind: 'help' };
    default: return { kind: 'unknown', name: cmd ?? '' };
  }
}
