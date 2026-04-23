// tests/permission/policy-store.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyStore } from '../../src/permission/policy-store.js';
import type { PermissionRequest } from '../../src/runtime/types.js';

function req(
  toolName: string,
  toolInput: Record<string, unknown> = {},
): PermissionRequest {
  return {
    id: 'any',
    category: 'generic',
    toolName,
    toolInput,
    resolve: () => undefined,
  };
}

describe('PolicyStore', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tlive-policy-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('add, list, save, load roundtrip', async () => {
    const file = join(dir, 'policies.json');
    const store1 = new PolicyStore('ws-1', { file });
    await store1.load();
    const rule = await store1.add({ toolName: 'Read' }, 'allow', 'workspace', 'user-a');
    expect(rule.id).toMatch(/^pol-/);
    expect(store1.list()).toHaveLength(1);

    // Second store loads from disk.
    const store2 = new PolicyStore('ws-1', { file });
    await store2.load();
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0]).toMatchObject({
      decision: 'allow', scope: 'workspace', createdBy: 'user-a',
      pattern: { toolName: 'Read' },
    });
  });

  it('match toolName exactly', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    await store.add({ toolName: 'Read' }, 'allow', 'workspace', 'u');
    expect(store.match(req('Read'))).not.toBeNull();
    expect(store.match(req('Write'))).toBeNull();
  });

  it('match inputMatch with glob wildcards', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    await store.add(
      { toolName: 'Read', inputMatch: { path: '*.md' } },
      'allow',
      'workspace',
      'u',
    );
    // `*` is a greedy match-any (including `/`) so both paths hit.
    expect(store.match(req('Read', { path: 'README.md' }))).not.toBeNull();
    expect(store.match(req('Read', { path: 'docs/spec.md' }))).not.toBeNull();
    expect(store.match(req('Read', { path: 'foo.txt' }))).toBeNull();
  });

  it('deep glob pattern with leading wildcard', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    await store.add(
      { toolName: 'Bash', inputMatch: { command: 'npm *' } },
      'allow',
      'workspace',
      'u',
    );
    expect(store.match(req('Bash', { command: 'npm test' }))).not.toBeNull();
    expect(store.match(req('Bash', { command: 'npm run build' }))).not.toBeNull();
    expect(store.match(req('Bash', { command: 'pnpm test' }))).toBeNull();
  });

  it('nested inputMatch recurses', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    await store.add(
      { toolName: 'Edit', inputMatch: { options: { strict: true } } },
      'deny',
      'workspace',
      'u',
    );
    expect(store.match(req('Edit', { options: { strict: true } }))).not.toBeNull();
    expect(store.match(req('Edit', { options: { strict: false } }))).toBeNull();
    expect(store.match(req('Edit', { options: {} }))).toBeNull();
  });

  it('inputMatch without toolName still filters', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    await store.add({ inputMatch: { path: '*.env' } }, 'deny', 'workspace', 'u');
    expect(store.match(req('Read', { path: '.env' }))).not.toBeNull();
    expect(store.match(req('Write', { path: 'prod.env' }))).not.toBeNull();
    expect(store.match(req('Read', { path: 'notes.md' }))).toBeNull();
  });

  it('match returns first hit in insertion order', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    const a = await store.add({ toolName: 'Read' }, 'allow', 'workspace', 'u');
    await store.add({ toolName: 'Read' }, 'deny', 'workspace', 'u');
    const hit = store.match(req('Read'));
    expect(hit?.id).toBe(a.id);
  });

  it('remove is idempotent (false for missing id)', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    const rule = await store.add({ toolName: 'Read' }, 'allow', 'workspace', 'u');
    expect(await store.remove(rule.id)).toBe(true);
    expect(await store.remove(rule.id)).toBe(false);
    expect(await store.remove('pol-does-not-exist')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('load tolerates missing file', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'missing.json') });
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('load tolerates malformed JSON', async () => {
    const file = join(dir, 'bad.json');
    await (await import('node:fs')).promises.writeFile(file, '{ not json', 'utf8');
    const store = new PolicyStore('ws', { file });
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('workspace isolation: two stores with different files do not share rules', async () => {
    const a = new PolicyStore('ws-a', { file: join(dir, 'a.json') });
    const b = new PolicyStore('ws-b', { file: join(dir, 'b.json') });
    await a.add({ toolName: 'Read' }, 'allow', 'workspace', 'u');
    await b.load();
    expect(b.list()).toEqual([]);
  });

  it('save uses atomic tmp+rename (no .tmp leftover on success)', async () => {
    const file = join(dir, 'atom.json');
    const store = new PolicyStore('ws', { file });
    await store.add({ toolName: 'Read' }, 'allow', 'workspace', 'u');
    const contents = await readFile(file, 'utf8');
    expect(JSON.parse(contents).rules).toHaveLength(1);
    const entries = await (await import('node:fs')).promises.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('non-object input never matches inputMatch', async () => {
    const store = new PolicyStore('ws', { file: join(dir, 'p.json') });
    await store.add({ inputMatch: { a: 1 } }, 'allow', 'workspace', 'u');
    // toolInput is an array, not an object record — matcher must reject.
    const r: PermissionRequest = {
      id: 'x', category: 'generic', toolName: 'X', toolInput: [1, 2, 3],
      resolve: () => undefined,
    };
    expect(store.match(r)).toBeNull();
  });
});
