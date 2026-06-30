import { describe, it, expect } from 'vitest';
import { buildCard } from '../feishu.js';

describe('feishu buildCard', () => {
  it('renders approval buttons as callback behaviors carrying the button id', () => {
    const card = buildCard({
      kind: 'card',
      title: '权限请求: Edit',
      body: 'tool input: {...}',
      buttons: [
        { id: 'approve:abc', label: '✅ 允许' },
        { id: 'deny:abc', label: '❌ 拒绝' },
      ],
    }) as { header?: unknown; elements: Array<Record<string, unknown>> };

    expect(card.header).toBeTruthy();
    const action = card.elements.find((e) => e.tag === 'action') as
      | { actions: Array<{ tag: string; type: string; behaviors: Array<{ type: string; value: { tlive: string } }> }> }
      | undefined;
    expect(action).toBeTruthy();
    expect(action!.actions).toHaveLength(2);
    expect(action!.actions[0]).toMatchObject({
      tag: 'button',
      type: 'primary',
      behaviors: [{ type: 'callback', value: { tlive: 'approve:abc' } }],
    });
    expect(action!.actions[1].type).toBe('danger');
    expect(action!.actions[1].behaviors[0].value.tlive).toBe('deny:abc');
  });

  it('omits the action element when there are no buttons', () => {
    const card = buildCard({ kind: 'card', body: 'hi' }) as { elements: Array<Record<string, unknown>> };
    expect(card.elements.some((e) => e.tag === 'action')).toBe(false);
    expect(card.elements[0]).toMatchObject({ tag: 'div' });
  });
});
