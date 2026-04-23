import { describe, it, expect } from 'vitest';
import { pipelineCmd } from '../../../src/im/commands/pipeline.js';
import { buildCtx } from './_helpers.js';

describe('/pipeline', () => {
  it('list reports stub', async () => {
    const { ctx, replies } = buildCtx();
    await pipelineCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/Pipelines/);
  });

  it('create echoes the name', async () => {
    const { ctx, replies } = buildCtx();
    await pipelineCmd.run(ctx, ['create', 'mypipe']);
    expect(replies[0]).toMatch(/Pipeline mypipe registered/);
  });
});
