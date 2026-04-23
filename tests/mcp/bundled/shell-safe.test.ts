// tests/mcp/bundled/shell-safe.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLsTool, makeCatTool, makeGrepTool, makeFindTool, makeShellSafeTools } from '../../../src/mcp/bundled/shell-safe/server.js';

describe('shell-safe bundled MCP', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlive-shell-'));
    await writeFile(join(root, 'a.txt'), 'hello\nworld\n');
    await writeFile(join(root, 'b.txt'), 'another');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('ls lists files', async () => {
    const r = await makeLsTool().handler({ path: root });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/a\.txt/);
  });

  it('cat reads a file', async () => {
    const r = await makeCatTool().handler({ path: join(root, 'a.txt') });
    expect(r.content[0]!.text).toContain('hello');
  });

  it('grep matches pattern', async () => {
    const r = await makeGrepTool().handler({ pattern: 'hello', path: join(root, 'a.txt') });
    expect(r.content[0]!.text).toContain('hello');
  });

  it('find locates files by name', async () => {
    const r = await makeFindTool().handler({ path: root, name: 'a.txt' });
    expect(r.content[0]!.text).toMatch(/a\.txt/);
  });

  it('makeShellSafeTools returns four tools', () => {
    expect(makeShellSafeTools()).toHaveLength(4);
  });
});
