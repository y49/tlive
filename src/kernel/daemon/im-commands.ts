// src/kernel/daemon/im-commands.ts
//
// IM command set: /perm, /trust, /safe, /help. Each earns its place by being
// something you'd actually fire FROM the phone. /desktop was dropped: it toggles
// a toast on the daemon's OWN machine, so you'd flip it AT that machine — it
// lives on only as the CLI `tlive desktop on|off` (and the daemon.set 'desktop'
// wire behind it), never as an IM command. (/use was removed earlier — no
// workspace binding.)

export type ImCommand =
  | { kind: 'perm'; enabled: boolean }
  | { kind: 'trust'; enabled: boolean }
  | { kind: 'safe'; enabled: boolean }
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
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', name: cmd ?? '' };
  }
}
