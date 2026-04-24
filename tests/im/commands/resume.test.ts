import { describe, it, expect } from 'vitest';
import { resumeCmd } from '../../../src/im/commands/resume.js';
import { buildCtx } from './_helpers.js';

describe('/resume', () => {
  it('reports usage when no alias supplied', async () => {
    const { ctx, replies } = buildCtx();
    await resumeCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('reports when session is already live', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'abcd', shortAlias: 'abcd1234' } as never,
    });
    await resumeCmd.run(ctx, ['abcd1234']);
    expect(replies[0]).toMatch(/already live/);
  });

  it('calls resumeLocal on miss', async () => {
    const { ctx, replies, sessionCalls } = buildCtx();
    await resumeCmd.run(ctx, ['deadbeef']);
    expect(sessionCalls.some((c) => c.method === 'resumeLocal')).toBe(true);
    expect(replies[0]).toMatch(/Resumed/);
  });

  it('reports ambiguous prefix with candidate list', async () => {
    const { ctx, replies, sessionCalls } = buildCtx({
      activeSession: { id: 'sess-1', shortAlias: 'abc12345' } as never,
      sessions: [{ id: 'sess-2', shortAlias: 'abc19999' } as never],
    });
    await resumeCmd.run(ctx, ['abc1']);
    expect(replies.join('\n')).toMatch(/ambiguous/i);
    expect(replies.join('\n')).toMatch(/abc12345/);
    expect(replies.join('\n')).toMatch(/abc19999/);
    // ambiguous → we must NOT fall through to resumeLocal
    expect(sessionCalls.some((c) => c.method === 'resumeLocal')).toBe(false);
  });

  it('unambiguous prefix resolves to live session', async () => {
    const { ctx, replies } = buildCtx({
      activeSession: { id: 'sess-1', shortAlias: 'abc12345' } as never,
      sessions: [{ id: 'sess-2', shortAlias: 'abc19999' } as never],
    });
    await resumeCmd.run(ctx, ['abc12']);
    expect(replies[0]).toMatch(/already live/);
  });
});
