// src/kernel/daemon/im-commands.ts
//
// IM command set: /mute, /trust, /safe, /help. Each earns its place by being
// something you'd actually fire FROM the phone. `/mute on` = go quiet, `/mute
// off` = notifications back on (polarity matches /trust /safe: "on" = that mode
// engaged). It governs IM notifications ONLY — the desktop toast fires
// whenever something is blocking on you regardless, with no on/off switch of
// its own (OS Do Not Disturb, or `tlive mode off`, cover that need instead).
// (/use was removed earlier — no workspace binding.)

import { MODES } from '../config/mode.js';
import type { ShimMode } from '../hook/normalizer.js';

export type ImCommand =
  | { kind: 'mute'; muted: boolean }
  | { kind: 'trust'; enabled: boolean }
  | { kind: 'safe'; enabled: boolean }
  /** A toggle command tapped from the client's command menu, which sends it bare
   *  (no on|off) — or with a bad arg. Instead of "Unknown command", the handler
   *  replies with explicit on/off buttons (see runCommand). Explicit (not a blind
   *  toggle) so a menu tap can never one-shot flip a dangerous state like /trust. */
  | { kind: 'toggle-prompt'; which: 'mute' | 'trust' | 'safe' }
  /** Posture ladder (off|notify|full|all) — the one command you fire from the
   *  phone when you realise you have left the keyboard. Unlike the runtime
   *  toggles it persists to config.json, because "I'm out" must survive a
   *  daemon restart. */
  | { kind: 'mode'; mode: ShimMode }
  /** Bare /mode (menu tap) or an unknown level → show the ladder with a button
   *  per rung, same explicit-choice rule as toggle-prompt. */
  | { kind: 'mode-prompt' }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

export function parseImCommand(text: string): ImCommand | null {
  if (!text.startsWith('/')) return null;
  const trimmed = text.trim();
  const [rawCmd, ...args] = trimmed.slice(1).split(/\s+/);
  // Telegram group menus send `/mute@botname` — strip the @mention so the command
  // resolves the same as in a private chat.
  const cmd = rawCmd.split('@')[0];
  const arg = args[0];
  switch (cmd) {
    case 'mute':
      if (arg === 'on') return { kind: 'mute', muted: true };
      if (arg === 'off') return { kind: 'mute', muted: false };
      return { kind: 'toggle-prompt', which: 'mute' };
    case 'trust':
      if (arg === 'on') return { kind: 'trust', enabled: true };
      if (arg === 'off') return { kind: 'trust', enabled: false };
      return { kind: 'toggle-prompt', which: 'trust' };
    case 'safe':
      if (arg === 'on') return { kind: 'safe', enabled: true };
      if (arg === 'off') return { kind: 'safe', enabled: false };
      return { kind: 'toggle-prompt', which: 'safe' };
    case 'mode':
      return MODES.includes(arg as ShimMode) ? { kind: 'mode', mode: arg as ShimMode } : { kind: 'mode-prompt' };
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', name: cmd ?? '' };
  }
}
