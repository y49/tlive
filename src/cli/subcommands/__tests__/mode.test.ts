import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMode } from '../mode.js';

describe('tlive mode <off|notify|full> — persists the posture to config.json', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tlive-mode-')); process.env.TLIVE_HOME = home; });
  afterEach(() => { delete process.env.TLIVE_HOME; rmSync(home, { recursive: true, force: true }); });

  it('sets mode on a fresh (missing) config', () => {
    runMode(['full']);
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
    expect(cfg.mode).toBe('full');
  });

  it('preserves every other config field when flipping mode', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      adapters: { telegram: { token: 't' } },
      approvals: { windowSec: 123, holdSubagents: true },
    }));
    runMode(['notify']);
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
    expect(cfg.mode).toBe('notify');
    expect(cfg.adapters.telegram.token).toBe('t');   // untouched
    expect(cfg.approvals.windowSec).toBe(123);         // untouched
    expect(cfg.approvals.holdSubagents).toBe(true);    // untouched
  });
});
