// src/kernel/daemon/im-commands.ts
//
// v2.1 command set: /perm, /help. (/use removed — no workspace binding.)

export type ImCommand =
  | { kind: 'perm'; enabled: boolean }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

export function parseImCommand(text: string): ImCommand | null {
  if (!text.startsWith('/')) return null;
  const trimmed = text.trim();
  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  switch (cmd) {
    case 'perm':
      if (args[0] === 'on') return { kind: 'perm', enabled: true };
      if (args[0] === 'off') return { kind: 'perm', enabled: false };
      return { kind: 'unknown', name: cmd };
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', name: cmd ?? '' };
  }
}
