import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionScanner, type SessionEvent, type ToolUseEvent } from '../../src/core/sessionScanner.js';

// Mock homedir so we control file paths
vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return { ...actual, homedir: () => join(tmpdir(), 'tlive-scanner-test') };
});

describe('SessionScanner', () => {
  const testHome = join(tmpdir(), 'tlive-scanner-test');
  let scanner: SessionScanner;

  beforeEach(() => mkdirSync(testHome, { recursive: true }));
  afterEach(() => {
    scanner?.stop();
    rmSync(testHome, { recursive: true, force: true });
  });

  function createScanner(sessionId: string, workdir: string, overrides = {}) {
    scanner = new SessionScanner({
      sessionId, workdir,
      pollingInterval: 50,
      proactiveNotifyDelay: 100,
      proactiveQuestionDelay: 50,
      ...overrides,
    });
    mkdirSync(join(scanner.filePath, '..'), { recursive: true });
    return scanner;
  }

  it('emits events for new jsonl lines', async () => {
    const s = createScanner('sess-1', '/tmp/myproject');
    const events: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => events.push(e));

    writeFileSync(s.filePath, JSON.stringify({
      uuid: 'u1', type: 'assistant', message: [{ type: 'text', text: 'Hello' }],
    }) + '\n');

    s.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(1);
    expect(events[0].uuid).toBe('u1');
  });

  it('deduplicates by UUID', async () => {
    const s = createScanner('sess-2', '/tmp/proj');
    const events: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => events.push(e));

    const line = JSON.stringify({ uuid: 'dup1', type: 'assistant', message: [] }) + '\n';
    writeFileSync(s.filePath, line + line);

    s.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(1);
  });

  it('skips system and summary events', async () => {
    const s = createScanner('sess-3', '/tmp/proj');
    const events: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => events.push(e));

    writeFileSync(s.filePath, [
      JSON.stringify({ uuid: 's1', type: 'system', message: 'init' }),
      JSON.stringify({ uuid: 's2', type: 'summary', message: 'sum' }),
      JSON.stringify({ uuid: 's3', type: 'assistant', message: [] }),
    ].join('\n') + '\n');

    s.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(1);
    expect(events[0].uuid).toBe('s3');
  });

  it('emits permission_needed after delay when tool_use has no tool_result', async () => {
    const s = createScanner('sess-4', '/tmp/proj');
    const needed: ToolUseEvent[] = [];
    s.on('permission_needed', (e: ToolUseEvent) => needed.push(e));

    writeFileSync(s.filePath, JSON.stringify({
      uuid: 't1', type: 'assistant',
      message: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }],
    }) + '\n');

    s.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(needed).toHaveLength(1);
    expect(needed[0].toolName).toBe('Bash');
    expect(needed[0].toolUseId).toBe('tu-1');
  });

  it('cancels notification when tool_result arrives in time', async () => {
    const s = createScanner('sess-5', '/tmp/proj');
    const needed: ToolUseEvent[] = [];
    s.on('permission_needed', (e: ToolUseEvent) => needed.push(e));

    writeFileSync(s.filePath, JSON.stringify({
      uuid: 'a1', type: 'assistant',
      message: [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: {} }],
    }) + '\n');

    s.start();
    await new Promise((r) => setTimeout(r, 30));

    appendFileSync(s.filePath, JSON.stringify({
      uuid: 'r1', type: 'user',
      message: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'ok' }],
    }) + '\n');

    await new Promise((r) => setTimeout(r, 200));
    expect(needed).toHaveLength(0);
  });

  it('uses shorter delay for AskUserQuestion', async () => {
    const s = createScanner('sess-6', '/tmp/proj');
    const needed: ToolUseEvent[] = [];
    s.on('permission_needed', (e: ToolUseEvent) => needed.push(e));

    writeFileSync(s.filePath, JSON.stringify({
      uuid: 'q1', type: 'assistant',
      message: [{ type: 'tool_use', id: 'tu-q', name: 'AskUserQuestion', input: { question: 'yes?' } }],
    }) + '\n');

    s.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(needed).toHaveLength(1);
    expect(needed[0].toolName).toBe('AskUserQuestion');
  });

  it('reads incremental data from growing file', async () => {
    const s = createScanner('sess-7', '/tmp/proj');
    const events: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => events.push(e));

    writeFileSync(s.filePath, JSON.stringify({ uuid: 'i1', type: 'assistant', message: [] }) + '\n');
    s.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(1);

    appendFileSync(s.filePath, JSON.stringify({ uuid: 'i2', type: 'user', message: [] }) + '\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(2);
  });
});
