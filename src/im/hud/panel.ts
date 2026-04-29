// src/im/hud/panel.ts
//
// HudPanel — per-platform HUD renderer. send() is called once at turn_start;
// update() is called on each HudState delta (caller must already debounce);
// freeze() is called once on turn_end. Panels are responsible for content-hash
// dedupe: a no-op update when the rendered content is identical to last.

import type { HudState } from './state.js';

export interface HudPanel {
  send(state: HudState): Promise<string>;
  update(msgId: string, state: HudState): Promise<void>;
  freeze(msgId: string, state: HudState): Promise<void>;
}
