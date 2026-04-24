import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCmd } from '../../../src/im/commands/agent.js';
import { buildCtx } from './_helpers.js';

describe('/agent', () => {
  let sandbox: string;
  let prev: string | undefined;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tlive-agent-'));
    prev = process.env.TLIVE_CLAUDE_HOME;
    process.env.TLIVE_CLAUDE_HOME = sandbox;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TLIVE_CLAUDE_HOME;
    else process.env.TLIVE_CLAUDE_HOME = prev;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('lists agents via supportedAgents', async () => {
    const supportedAgents = async () => [{ name: 'coder', description: 'writes code' }];
    const { ctx, replies } = buildCtx({
      workspace: { activeSessionId: 'sess-0000-0000-0000-0000' },
      activeSession: { id: 'sess-0000-0000-0000-0000', shortAlias: 'abcd1234', supportedAgents } as never,
    });
    await agentCmd.run(ctx, ['list']);
    expect(replies[0]).toContain('coder');
  });

  it('create writes a markdown file and reports the path', async () => {
    const { ctx, replies } = buildCtx();
    await agentCmd.run(ctx, ['create', 'mybot', '"does', 'things"']);
    const path = join(sandbox, 'agents', 'mybot.md');
    expect(existsSync(path)).toBe(true);
    expect(replies[0]).toMatch(/Agent mybot written to/);
    expect(replies[0]).toContain(path);
    const body = readFileSync(path, 'utf8');
    expect(body).toMatch(/name: mybot/);
    expect(body).toMatch(/description: does things/);
  });

  it('remove deletes an existing agent file', async () => {
    const { ctx: ctx1 } = buildCtx();
    await agentCmd.run(ctx1, ['create', 'mybot', '"does', 'things"']);
    const { ctx: ctx2, replies: replies2 } = buildCtx();
    await agentCmd.run(ctx2, ['remove', 'mybot']);
    expect(replies2[0]).toMatch(/removed/);
  });
});
