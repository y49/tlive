import { describe, it, expect } from 'vitest';
import { scheduleCmd } from '../../../src/im/commands/schedule.js';
import { buildCtx } from './_helpers.js';

describe('/schedule', () => {
  it('list reports stub', async () => {
    const { ctx, replies } = buildCtx();
    await scheduleCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/Schedules/);
  });

  it('create acknowledges kind', async () => {
    const { ctx, replies } = buildCtx();
    await scheduleCmd.run(ctx, ['create', 'daily', '10:00', 'do', 'the', 'thing']);
    expect(replies[0]).toMatch(/Schedule \(daily\)/);
  });
});
