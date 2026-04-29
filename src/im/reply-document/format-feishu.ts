// src/im/reply-document/format-feishu.ts
//
// PLACEHOLDER — T6 replaces with full lark card 2.0 renderer.

import type { HudState } from '../hud/state.js';

export interface FeishuRender { card: object; }

export function renderFeishu(state: HudState, body: string): FeishuRender {
  const banner = state.isErrored ? 'error' : state.isFrozen ? 'done' : 'thinking';
  return {
    card: {
      schema: '2.0',
      header: { template: 'blue', title: { tag: 'plain_text', content: banner } },
      body: { elements: [{ tag: 'markdown', content: body || '_thinking…_' }] },
    },
  };
}
