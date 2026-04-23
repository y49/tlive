// tests/mcp/registry.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpRegistry } from '../../src/mcp/registry.js';

describe('McpRegistry', () => {
  let root: string;
  let reg: McpRegistry;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-reg-'));
    reg = new McpRegistry({ file: join(root, 'registry.json') });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('add / get / list / remove', async () => {
    await reg.add({ name: 'github', config: { command: 'gh' }, enabled: true });
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('github')!.enabled).toBe(true);
    expect(await reg.remove('github')).toBe(true);
    expect(reg.list()).toHaveLength(0);
  });

  it('setEnabled flips the entry', async () => {
    await reg.add({ name: 'gh', config: { command: 'gh' }, enabled: false });
    expect(await reg.setEnabled('gh', true)).toBe(true);
    expect(reg.get('gh')!.enabled).toBe(true);
  });

  it('workspace scoping allows only listed ids', async () => {
    await reg.add({ name: 'gh', config: { command: 'gh' }, enabled: true, workspaceIds: ['w-1'] });
    expect(reg.isAllowedForWorkspace('gh', 'w-1')).toBe(true);
    expect(reg.isAllowedForWorkspace('gh', 'w-2')).toBe(false);
    await reg.add({ name: 'web', config: { command: 'web' }, enabled: true });
    expect(reg.isAllowedForWorkspace('web', 'any')).toBe(true);
  });

  it('persists across load()', async () => {
    await reg.add({ name: 'gh', config: { command: 'gh' }, enabled: true });
    const reg2 = new McpRegistry({ file: join(root, 'registry.json') });
    await reg2.load();
    expect(reg2.get('gh')).toBeDefined();
  });
});
