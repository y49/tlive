// tests/attachment/store.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from '../../src/attachment/store.js';

describe('AttachmentStore', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tlive-att-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('register writes file to direction/session subdir + indexes metadata', async () => {
    const store = new AttachmentStore({ rootDir: root });
    await store.init();
    const buf = Buffer.from('hello world');
    const att = await store.register('sess-1', 'a.txt', 'text/plain', buf, 'inbound');
    expect(att.sessionId).toBe('sess-1');
    expect(att.name).toBe('a.txt');
    expect(att.mime).toBe('text/plain');
    expect(att.sizeBytes).toBe(buf.length);
    expect(att.direction).toBe('inbound');
    expect(att.path).toContain(join(root, 'inbound', 'sess-1'));
    const onDisk = await readFile(att.path);
    expect(onDisk.equals(buf)).toBe(true);
  });

  it('get and listForSession return registered attachments', async () => {
    const store = new AttachmentStore({ rootDir: root });
    await store.init();
    const a = await store.register('s1', 'a.txt', 'text/plain', Buffer.from('a'), 'inbound');
    const b = await store.register('s1', 'b.png', 'image/png', Buffer.from('b'), 'outbound');
    await store.register('s2', 'c.txt', 'text/plain', Buffer.from('c'), 'inbound');
    expect(store.get(a.id)).toEqual(a);
    expect(store.get(b.id)).toEqual(b);
    const s1List = store.listForSession('s1');
    expect(s1List).toHaveLength(2);
    expect(new Set(s1List.map((x) => x.id))).toEqual(new Set([a.id, b.id]));
    expect(store.listForSession('s2')).toHaveLength(1);
    expect(store.size()).toBe(3);
  });

  it('sanitizes dangerous filenames (no path escape)', async () => {
    const store = new AttachmentStore({ rootDir: root });
    await store.init();
    const att = await store.register('s', '../evil.sh', 'text/plain', Buffer.from('x'), 'inbound');
    // Path stays under root/inbound/s/.
    expect(att.path.startsWith(join(root, 'inbound', 's'))).toBe(true);
    // Original name preserved in metadata for display.
    expect(att.name).toBe('../evil.sh');
  });

  it('get returns undefined for unknown id', async () => {
    const store = new AttachmentStore({ rootDir: root });
    await store.init();
    expect(store.get('nope')).toBeUndefined();
  });

  it('registers distinct ids for concurrent same-name files', async () => {
    const store = new AttachmentStore({ rootDir: root });
    await store.init();
    const a = await store.register('s', 'x.txt', 'text/plain', Buffer.from('1'), 'inbound');
    const b = await store.register('s', 'x.txt', 'text/plain', Buffer.from('2'), 'inbound');
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
  });
});
