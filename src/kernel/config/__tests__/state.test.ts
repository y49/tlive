import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, markNotifyExplained, wasNotifyExplained } from '../state.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tlive-state-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('daemon state', () => {
  it('reads as empty when the file has never been written', () => {
    expect(readState(home)).toEqual({});
    expect(wasNotifyExplained(home, 'telegram:1')).toBe(false);
  });

  it('remembers across processes — "told once" must not mean "told once per daemon"', () => {
    markNotifyExplained(home, 'telegram:1');
    expect(wasNotifyExplained(home, 'telegram:1')).toBe(true);
    expect(wasNotifyExplained(home, 'feishu:9')).toBe(false);
  });

  it('marking twice does not duplicate the entry', () => {
    markNotifyExplained(home, 'telegram:1');
    markNotifyExplained(home, 'telegram:1');
    expect(readState(home).notifyExplainedChats).toEqual(['telegram:1']);
  });

  it('a corrupt state file degrades to empty instead of crashing the daemon', () => {
    writeFileSync(join(home, 'state.json'), '{ not json');
    expect(readState(home)).toEqual({});
    markNotifyExplained(home, 'telegram:1');
    expect(wasNotifyExplained(home, 'telegram:1')).toBe(true);
  });

  it('never touches config.json', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ mode: 'notify' }));
    markNotifyExplained(home, 'telegram:1');
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'))).toEqual({ mode: 'notify' });
    expect(existsSync(join(home, 'state.json'))).toBe(true);
  });
});
