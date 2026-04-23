import { describe, it, expect } from 'vitest';
import { revokeCmd } from '../../../src/im/commands/revoke.js';
import { buildCtx } from './_helpers.js';

describe('/revoke', () => {
  it('usage on missing arg', async () => {
    const { ctx, replies } = buildCtx();
    await revokeCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('clears role when present', async () => {
    const { ctx, replies } = buildCtx({
      workspace: { roles: { alice: 'operator' } as never },
    });
    await revokeCmd.run(ctx, ['@alice']);
    expect(replies[0]).toMatch(/Revoked/);
  });

  it('reports when no explicit grants', async () => {
    const { ctx, replies } = buildCtx();
    await revokeCmd.run(ctx, ['bob']);
    expect(replies[0]).toMatch(/no explicit role grants/);
  });
});
