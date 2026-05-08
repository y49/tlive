import { describe, it, expect } from 'vitest';
import { budgetCmd } from '../../../src/im/commands/budget.js';
import { buildCtx } from './_helpers.js';

describe('/budget', () => {
  it('no args: shows used / cap / remaining + quick buttons', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      getMaxBudget: () => 10,
      cost: { totalCost: 1.23 },
    };
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await budgetCmd.run(ctx, []);
    expect(replies[0]).toMatch(/已用.*\$1\.23/);
    expect(replies[0]).toMatch(/上限.*\$10/);
    expect(replies[0]).toMatch(/剩余.*\$8\.77/);
    expect(replyMarkups[0]).toBeTruthy();
    const labels = (replyMarkups[0]!.buttons ?? []).flat().map((b) => b.text);
    expect(labels).toContain('$1');
    expect(labels).toContain('$5');
    expect(labels).toContain('$20');
    expect(labels).toContain('$100');
    expect(labels).toContain('$200');
    expect(labels).toContain('无限');
    // Custom stub removed (Option B — text path /budget <usd> covers custom).
  });

  it('no args, no cap set: shows 无限 and omits remaining line', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      getMaxBudget: () => undefined,
      cost: { totalCost: 0.5 },
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await budgetCmd.run(ctx, []);
    expect(replies[0]).toMatch(/上限.*无限/);
    expect(replies[0]).not.toMatch(/剩余/);
  });

  it('numeric arg: sets cap', async () => {
    let captured: number | undefined = -1;
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      setMaxBudget: (v: number | undefined) => { captured = v; },
      cost: { totalCost: 0 },
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await budgetCmd.run(ctx, ['25']);
    expect(captured).toBe(25);
    expect(replies[0]).toMatch(/\$25\.00/);
  });

  it('"unlimited" arg: clears cap', async () => {
    let captured: number | undefined = 999;
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      setMaxBudget: (v: number | undefined) => { captured = v; },
      cost: { totalCost: 0 },
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await budgetCmd.run(ctx, ['unlimited']);
    expect(captured).toBeUndefined();
    expect(replies[0]).toMatch(/无限/);
  });

  it('invalid arg: usage prompt', async () => {
    const fakeSession = {
      kind: 'local' as const,
      id: 's1',
      shortAlias: 's1',
      setMaxBudget: () => {},
      cost: { totalCost: 0 },
    };
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 's1' },
      activeSession: fakeSession as never,
    });
    await budgetCmd.run(ctx, ['notanumber']);
    expect(replies[0]).toMatch(/用法/);
  });

  it('no active session: friendly message', async () => {
    const { ctx, replies } = buildCtx({ workspace: { activeSessionId: null } });
    await budgetCmd.run(ctx, []);
    expect(replies[0]).toMatch(/活跃会话|no active session/i);
  });
});
