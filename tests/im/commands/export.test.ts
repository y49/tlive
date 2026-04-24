import { describe, it, expect } from 'vitest';
import { exportCmd } from '../../../src/im/commands/export.js';
import { buildCtx } from './_helpers.js';
import type { SessionPersistence } from '../../../src/session/persistence.js';
import type { NotificationEvent } from '../../../src/runtime/events.js';

function fakePersistence(events: NotificationEvent[]): SessionPersistence {
  return {
    async loadHistory() { return events; },
  } as unknown as SessionPersistence;
}

describe('/export', () => {
  it('reports usage on missing alias', async () => {
    const { ctx, replies } = buildCtx();
    await exportCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('warns when persistence not wired', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    await exportCmd.run(ctx, ['abcd1234']);
    expect(replies[0]).toMatch(/persistence not wired/);
  });

  it('exports md when persistence is wired', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    ctx.persistence = fakePersistence([
      { kind: 'assistant_text', turnId: 't1', text: 'hi there', complete: true } as NotificationEvent,
    ]);
    await exportCmd.run(ctx, ['abcd1234']);
    expect(replies[0]).toMatch(/abcd1234/);
    expect(replies[0]).toContain('hi there');
  });

  it('accepts json format', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234' } as never,
    });
    ctx.persistence = fakePersistence([
      { kind: 'assistant_text', turnId: 't1', text: 'hi', complete: true } as NotificationEvent,
    ]);
    await exportCmd.run(ctx, ['abcd1234', 'json']);
    expect(replies[0]).toContain('"role"');
    expect(replies[0]).toContain('assistant');
  });
});
