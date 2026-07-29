import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODES, MODE_DESC, writeMode } from '../mode.js';

describe('posture ladder', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tlive-modemod-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('is the four rungs, in escalation order', () => {
    expect(MODES).toEqual(['off', 'notify', 'full', 'all']);
  });

  it('every rung has one description, shared by CLI / status / IM', () => {
    for (const m of MODES) expect(MODE_DESC[m].startsWith(`${m} —`)).toBe(true);
  });

  it('writes mode into a missing config (creating the home dir)', () => {
    const nested = join(home, 'sub');
    const p = writeMode(nested, 'all');
    expect(JSON.parse(readFileSync(p, 'utf-8')).mode).toBe('all');
  });

  it('round-trips every other field untouched', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      adapters: { telegram: { token: 't' } },
      approvals: { windowSec: 123 },
      allowedSenders: [{ channel: 'telegram', userId: 'u1' }],
    }));
    writeMode(home, 'full');
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
    expect(cfg.mode).toBe('full');
    expect(cfg.adapters.telegram.token).toBe('t');
    expect(cfg.approvals.windowSec).toBe(123);
    expect(cfg.allowedSenders).toHaveLength(1);
  });

  it('a corrupt config is replaced, not thrown on', () => {
    writeFileSync(join(home, 'config.json'), '{ not json');
    writeMode(home, 'notify');
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'))).toEqual({ mode: 'notify' });
    expect(existsSync(join(home, 'config.json'))).toBe(true);
  });
});
