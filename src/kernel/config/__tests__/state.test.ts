import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, markNotifyExplained, wasNotifyExplained, readToastId, writeToastId } from '../state.js';

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

  // I3: writeState now writes to a temp sibling then renameSync()s it over the
  // target instead of a bare writeFileSync (O_TRUNC then write) — a kill
  // between those two steps used to leave a 0-byte state.json, and since
  // toastId shares this file, that stranded a live toast (not just a re-sent
  // explanation card).
  describe('atomic writes (I3)', () => {
    it('persists and reads back the toast id, and null clears it', () => {
      expect(readToastId(home)).toBeNull();
      writeToastId(home, '42');
      expect(readToastId(home)).toBe('42');
      writeToastId(home, null);
      expect(readToastId(home)).toBeNull();
    });

    it('toastId and notifyExplainedChats share one file without one write clobbering the other', () => {
      markNotifyExplained(home, 'telegram:1');
      writeToastId(home, '42');
      expect(wasNotifyExplained(home, 'telegram:1')).toBe(true);
      expect(readToastId(home)).toBe('42');
      markNotifyExplained(home, 'feishu:9');
      expect(readToastId(home)).toBe('42');
      expect(readState(home).notifyExplainedChats).toEqual(['telegram:1', 'feishu:9']);
    });

    it('leaves no temp file behind after a normal write', () => {
      markNotifyExplained(home, 'telegram:1');
      writeToastId(home, '42');
      const files = readdirSync(home);
      expect(files).toContain('state.json');
      expect(files.some((f) => f.includes('.tmp'))).toBe(false);
    });
  });
});
