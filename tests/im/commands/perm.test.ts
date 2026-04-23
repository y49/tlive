import { describe, it, expect, vi } from 'vitest';
import { permCmd } from '../../../src/im/commands/perm.js';
import { buildCtx } from './_helpers.js';

describe('/perm', () => {
  it('reports missing store', async () => {
    const { ctx, replies } = buildCtx();
    await permCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/PolicyStore not wired/);
  });

  it('list returns policy rules', async () => {
    const { ctx, replies } = buildCtx();
    ctx.policyStoreFor = () => ({
      list: () => [{ id: 'p1', pattern: { toolName: 'Bash' }, decision: 'allow', scope: 'workspace', createdBy: 'u', createdAt: '' }],
      add: vi.fn(),
    }) as unknown as ReturnType<NonNullable<typeof ctx.policyStoreFor>>;
    await permCmd.run(ctx, ['list']);
    expect(replies[0]).toContain('p1');
    expect(replies[0]).toContain('Bash');
  });

  it('allow adds a rule', async () => {
    const add = vi.fn(async () => ({ id: 'p2', pattern: {}, decision: 'allow', scope: 'workspace', createdBy: 'u', createdAt: '' }));
    const { ctx, replies } = buildCtx();
    ctx.policyStoreFor = () => ({ list: () => [], add }) as unknown as ReturnType<NonNullable<typeof ctx.policyStoreFor>>;
    await permCmd.run(ctx, ['allow', 'Bash']);
    expect(add).toHaveBeenCalled();
    expect(replies[0]).toMatch(/Added allow rule/);
  });
});
