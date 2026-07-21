// src/kernel/daemon/im-commands.ts
//
// v2.1 command set: /perm, /trust, /safe, /desktop, /help. (/use removed — no workspace binding.)

export type ImCommand =
  | { kind: 'perm'; enabled: boolean }
  | { kind: 'trust'; enabled: boolean }
  | { kind: 'safe'; enabled: boolean }
  | { kind: 'desktop'; enabled: boolean }
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
    case 'trust':
      if (args[0] === 'on') return { kind: 'trust', enabled: true };
      if (args[0] === 'off') return { kind: 'trust', enabled: false };
      return { kind: 'unknown', name: cmd };
    case 'safe':
      if (args[0] === 'on') return { kind: 'safe', enabled: true };
      if (args[0] === 'off') return { kind: 'safe', enabled: false };
      return { kind: 'unknown', name: cmd };
    case 'desktop':
      if (args[0] === 'on') return { kind: 'desktop', enabled: true };
      if (args[0] === 'off') return { kind: 'desktop', enabled: false };
      return { kind: 'unknown', name: cmd };
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', name: cmd ?? '' };
  }
}
