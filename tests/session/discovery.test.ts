// tests/session/discovery.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSessions } from '../../src/session/discovery.js';

describe('discoverSessions', () => {
  it('uses injected SDK listSessions when provided', async () => {
    const results = await discoverSessions({
      providers: ['claude'],
      claudeListSessions: async () => [
        {
          sessionId: 'abc12345-1111-2222-3333-444444444444',
          summary: 'Summary',
          firstPrompt: 'Hello world',
          cwd: '/proj',
          lastModified: Date.now(),
          createdAt: Date.now() - 5000,
        },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0].sdkSessionId).toBe('abc12345-1111-2222-3333-444444444444');
    expect(results[0].preview).toBe('Hello world');
  });

  it('marks activeInDaemon when liveIds includes id', async () => {
    const results = await discoverSessions({
      providers: ['claude'],
      claudeListSessions: async () => [
        { sessionId: 'abc', summary: 's', lastModified: 1 },
      ],
      liveIds: new Set(['abc']),
    });
    expect(results[0].activeInDaemon).toBe(true);
  });

  it('falls back to filesystem scan when SDK throws', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tlive-disc-'));
    try {
      const proj = join(home, '.claude', 'projects', '-tmp-proj');
      await mkdir(proj, { recursive: true });
      const jsonl = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' } }),
      ].join('\n');
      await writeFile(join(proj, 'sess1.jsonl'), jsonl, 'utf8');

      const results = await discoverSessions({
        providers: ['claude'],
        home,
        claudeListSessions: async () => { throw new Error('offline'); },
      });
      expect(results.some((r) => r.sdkSessionId === 'sess1')).toBe(true);
      const hit = results.find((r) => r.sdkSessionId === 'sess1');
      expect(hit?.preview).toContain('hello there');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('sorts results by lastActivityAt desc', async () => {
    const results = await discoverSessions({
      providers: ['claude'],
      claudeListSessions: async () => [
        { sessionId: 'older', summary: 'o', lastModified: 100 },
        { sessionId: 'newer', summary: 'n', lastModified: 500 },
        { sessionId: 'middle', summary: 'm', lastModified: 300 },
      ],
    });
    expect(results.map((r) => r.sdkSessionId)).toEqual(['newer', 'middle', 'older']);
  });

  it('dedupes by sdkSessionId (SDK wins over fs)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tlive-dedup-'));
    try {
      const proj = join(home, '.claude', 'projects', '-proj');
      await mkdir(proj, { recursive: true });
      await writeFile(join(proj, 'dup.jsonl'), '', 'utf8');
      const results = await discoverSessions({
        providers: ['claude'],
        home,
        claudeListSessions: async () => [
          { sessionId: 'dup', summary: 'sdk', lastModified: 999 },
        ],
      });
      const dups = results.filter((r) => r.sdkSessionId === 'dup');
      expect(dups).toHaveLength(1);
      // The SDK record (first) wins — preview should be from SDK, not fs
      expect(dups[0].preview).toBe('sdk');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
