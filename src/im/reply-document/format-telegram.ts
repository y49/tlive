// src/im/reply-document/format-telegram.ts
//
// PLACEHOLDER — T5 replaces with full banner+body+blockquote-footer renderer.
// Currently echoes body with a thinking placeholder. ReplyDocument's
// "freeze" output relies on the body text containing 'done' when state.isFrozen
// — to keep the placeholder useful for T4 tests, we wedge state into the output.

import type { HudState } from '../hud/state.js';

export interface TelegramRender { html: string; }

export function renderTelegram(state: HudState, body: string): TelegramRender {
  const banner = state.isErrored
    ? `<b>error · ${state.errorSummary ?? ''}</b>`
    : state.isFrozen ? '<b>done</b>'
    : '<b>thinking</b>';
  const text = body.trim() || '<i>thinking...</i>';
  return { html: `${banner}\n${text}` };
}
