import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maybeAutoStartDaemon } from '../hook';

describe('maybeAutoStartDaemon', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const home = (cfg?: object): string => {
    const d = mkdtempSync(join(tmpdir(), 'tlive-as-')); dirs.push(d);
    if (cfg) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'config.json'), JSON.stringify(cfg)); }
    return d;
  };

  it('无 config(默认)→ spawn 被调,返回 true', () => {
    const calls: string[] = [];
    expect(maybeAutoStartDaemon(home(), (h) => { calls.push(h); return 123; })).toBe(true);
    expect(calls.length).toBe(1);
  });
  it('daemon.autoStart:false → 不 spawn,返回 false', () => {
    const calls: string[] = [];
    expect(maybeAutoStartDaemon(home({ daemon: { autoStart: false } }), (h) => { calls.push(h); return 123; })).toBe(false);
    expect(calls.length).toBe(0);
  });
  it('spawn 抛异常不外泄(fire-and-forget)', () => {
    expect(() => maybeAutoStartDaemon(home(), () => { throw new Error('boom'); })).not.toThrow();
  });
});
