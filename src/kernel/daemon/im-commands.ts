// src/kernel/daemon/im-commands.ts

export type ImCommand =
  | { kind: 'use'; workspaceId: string }
  | { kind: 'new' }
  | { kind: 'sessions' }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'handback' }
  | { kind: 'stop' }
  | { kind: 'kill' }
  | { kind: 'model'; name: string }
  | { kind: 'runtime'; provider: 'claude' | 'codex' }
  | { kind: 'perm'; enabled: boolean }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

export function parseImCommand(text: string): ImCommand | null {
  if (!text.startsWith('/')) return null;
  const trimmed = text.trim();
  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  switch (cmd) {
    case 'use': return args[0] ? { kind: 'use', workspaceId: args[0] } : { kind: 'unknown', name: cmd };
    case 'new': return { kind: 'new' };
    case 'sessions': return { kind: 'sessions' };
    case 'resume': return args[0] ? { kind: 'resume', sessionId: args[0] } : { kind: 'unknown', name: cmd };
    case 'handback': return { kind: 'handback' };
    case 'stop': return { kind: 'stop' };
    case 'kill': return { kind: 'kill' };
    case 'model': return args[0] ? { kind: 'model', name: args[0] } : { kind: 'unknown', name: cmd };
    case 'runtime':
      if (args[0] === 'claude' || args[0] === 'codex') return { kind: 'runtime', provider: args[0] };
      return { kind: 'unknown', name: cmd };
    case 'perm':
      if (args[0] === 'on') return { kind: 'perm', enabled: true };
      if (args[0] === 'off') return { kind: 'perm', enabled: false };
      return { kind: 'unknown', name: cmd };
    case 'help': return { kind: 'help' };
    default: return { kind: 'unknown', name: cmd };
  }
}
