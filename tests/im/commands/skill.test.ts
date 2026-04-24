import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillCmd } from '../../../src/im/commands/skill.js';
import { buildCtx } from './_helpers.js';

describe('/skill', () => {
  let sandbox: string;
  let prev: string | undefined;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tlive-skill-'));
    prev = process.env.TLIVE_CLAUDE_HOME;
    process.env.TLIVE_CLAUDE_HOME = sandbox;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TLIVE_CLAUDE_HOME;
    else process.env.TLIVE_CLAUDE_HOME = prev;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('list reports empty when no skills are installed', async () => {
    const { ctx, replies } = buildCtx();
    await skillCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/No skills installed/);
  });

  it('install requires arg', async () => {
    const { ctx, replies } = buildCtx();
    await skillCmd.run(ctx, ['install']);
    expect(replies[0]).toMatch(/Usage/);
  });

  it('remove reports not found for missing skill', async () => {
    const { ctx, replies } = buildCtx();
    await skillCmd.run(ctx, ['remove', 'nope']);
    expect(replies[0]).toMatch(/not found/);
  });
});
