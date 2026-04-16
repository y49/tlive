import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../messages/codex-adapter.js';
import { mapCanonicalToNotifications } from '../engine/sdk-engine.js';

describe('Codex SDK → NotificationEvent pipeline', () => {
  it('maps a full turn to expected notifications', () => {
    const adapter = new CodexAdapter();

    const canon1 = adapter.adapt({ type: 'turn.started' } as any);
    const canon2 = adapter.adapt({
      type: 'item.started',
      item: { id: 'r1', type: 'reasoning', text: '' },
    } as any);
    const canon3 = adapter.adapt({
      type: 'item.completed',
      item: { id: 'r1', type: 'reasoning', text: 'I will read and edit' },
    } as any);
    const canon4 = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'f1', type: 'file_change',
        changes: [{ path: 'a.ts', kind: 'update' }],
        status: 'completed',
      },
    } as any);
    const canon5 = adapter.adapt({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'Done editing a.ts' },
    } as any);
    const canon6 = adapter.adapt({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
    } as any);

    const allCanonical = [...canon1, ...canon2, ...canon3, ...canon4, ...canon5, ...canon6];
    const notifications = mapCanonicalToNotifications(allCanonical);

    const kinds = notifications.map((n) => n.kind);
    expect(kinds).toContain('reasoning_summary');
    expect(kinds).toContain('file_change_list');
  });
});
