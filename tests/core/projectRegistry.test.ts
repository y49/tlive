import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return { ...actual, homedir: () => join(tmpdir(), 'tlive-registry-test') };
});

import { ProjectRegistry } from '../../src/core/projectRegistry.js';

describe('ProjectRegistry', () => {
  const testHome = join(tmpdir(), 'tlive-registry-test');

  beforeEach(() => mkdirSync(join(testHome, '.tlive'), { recursive: true }));
  afterEach(() => rmSync(testHome, { recursive: true, force: true }));

  it('registers and lists projects', () => {
    const reg = new ProjectRegistry();
    reg.register('/home/user/proj-a', 'proj-a');
    reg.register('/home/user/proj-b', 'proj-b');
    expect(reg.list()).toHaveLength(2);
  });

  it('returns most recent project', async () => {
    const reg = new ProjectRegistry();
    reg.register('/a');
    await new Promise((r) => setTimeout(r, 10));
    reg.register('/b');
    expect(reg.getRecent()?.path).toBe('/b');
  });

  it('resolves by name', () => {
    const reg = new ProjectRegistry();
    reg.register('/home/user/myapp', 'myapp');
    expect(reg.resolve('myapp')?.path).toBe('/home/user/myapp');
    expect(reg.resolve('MyApp')?.path).toBe('/home/user/myapp');
  });

  it('persists across instances', () => {
    const reg1 = new ProjectRegistry();
    reg1.register('/x', 'x-proj');
    const reg2 = new ProjectRegistry();
    expect(reg2.list()).toHaveLength(1);
    expect(reg2.resolve('x-proj')?.path).toBe('/x');
  });

  it('removes projects', () => {
    const reg = new ProjectRegistry();
    reg.register('/del');
    expect(reg.remove('/del')).toBe(true);
    expect(reg.list()).toHaveLength(0);
    expect(reg.remove('/nonexistent')).toBe(false);
  });
});
