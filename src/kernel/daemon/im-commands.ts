// src/kernel/daemon/im-commands.ts
//
// IM command set: /mute, /trust, /safe, /help. Each earns its place by being
// something you'd actually fire FROM the phone. `/mute on` = go quiet, `/mute
// off` = notifications back on (polarity matches /trust /safe: "on" = that mode
// engaged). It governs IM notifications ONLY — desktop toasts are independent,
// with their own machine-local `tlive desktop on|off` (no IM command). /desktop
// was dropped from IM for the same reason (you flip it AT the machine).
// (/use was removed earlier — no workspace binding.)

export type ImCommand =
  | { kind: 'mute'; muted: boolean }
  | { kind: 'trust'; enabled: boolean }
  | { kind: 'safe'; enabled: boolean }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

export function parseImCommand(text: string): ImCommand | null {
  if (!text.startsWith('/')) return null;
  const trimmed = text.trim();
  const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
  switch (cmd) {
    case 'mute':
      if (args[0] === 'on') return { kind: 'mute', muted: true };
      if (args[0] === 'off') return { kind: 'mute', muted: false };
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
