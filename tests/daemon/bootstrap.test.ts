// tests/daemon/bootstrap.test.ts
//
// Exercises `bootstrapDaemon()` end-to-end with adapters and IPC disabled.
// The goal is to verify wiring: every subsystem is constructed, the IPC
// dispatcher receives requests via a direct handler call, lifecycle
// shutdown walks steps, no pending unhandled timers leak.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapDaemon, parseAskAnswer } from '../../src/daemon/bootstrap.js';
import { createLogger } from '../../src/util/logger.js';

const silentLogger = createLogger({ level: 'error', sink: () => undefined });

describe('bootstrapDaemon wiring', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tlive-boot-'));
    mkdirSync(join(home), { recursive: true });
    // Seed a minimal v1 config so loader doesn't synthesize one.
    const cfg = { version: '1', workspaces: [{ name: 'test', workdir: home }] };
    writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('constructs every subsystem and exposes them on the handle', async () => {
    const daemon = await bootstrapDaemon({
      home,
      startAdapters: false,
      startIpc: false,
      startHealth: false,
      logger: silentLogger,
    });
    try {
      expect(daemon.sessions).toBeDefined();
      expect(daemon.workspaces.list()).toHaveLength(1);
      expect(daemon.workspaces.list()[0]!.name).toBe('test');
      expect(daemon.permissionBroker).toBeDefined();
      expect(daemon.askBroker).toBeDefined();
      expect(daemon.elicitationBroker).toBeDefined();
      expect(daemon.mcpRegistry).toBeDefined();
      expect(daemon.attachments).toBeDefined();
      expect(daemon.warmPool).toBeDefined();
      expect(daemon.cron).toBeDefined();
      expect(daemon.federation).toBeDefined();
      expect(daemon.frontend).toBeDefined();
      expect(daemon.callbackRouter).toBeDefined();
      expect(daemon.autoResumeReport.attempted).toBe(0);
    } finally {
      await daemon.shutdown();
    }
  });

  it('shutdown is reentrant-safe', async () => {
    const daemon = await bootstrapDaemon({
      home,
      startAdapters: false,
      startIpc: false,
      startHealth: false,
      logger: silentLogger,
    });
    const a = daemon.shutdown();
    const b = daemon.shutdown();
    await Promise.all([a, b]);
    // second call should not throw; lifecycle cache ensures one-time run
    await daemon.shutdown();
  });

  describe('parseAskAnswer', () => {
    const opts = ['Coffee', 'Tea', 'Cola'];

    it('maps integer reply to option by 1-based index', () => {
      expect(parseAskAnswer('1', opts)).toBe('Coffee');
      expect(parseAskAnswer('2', opts)).toBe('Tea');
      expect(parseAskAnswer('  3 ', opts)).toBe('Cola');
    });

    it('rejects out-of-range integers', () => {
      expect(parseAskAnswer('0', opts)).toBeNull();
      expect(parseAskAnswer('4', opts)).toBeNull();
      expect(parseAskAnswer('-1', opts)).toBeNull();
    });

    it('matches case-insensitive label exactly', () => {
      expect(parseAskAnswer('tea', opts)).toBe('Tea');
      expect(parseAskAnswer('COLA', opts)).toBe('Cola');
    });

    it('matches a unique substring', () => {
      expect(parseAskAnswer('cof', opts)).toBe('Coffee');
    });

    it('rejects ambiguous substrings (multiple matches)', () => {
      const ambig = ['Green tea', 'Black tea', 'Coffee'];
      expect(parseAskAnswer('tea', ambig)).toBeNull();
    });

    it('returns null for unrelated text (caller treats as new prompt)', () => {
      expect(parseAskAnswer('hello world', opts)).toBeNull();
      expect(parseAskAnswer('', opts)).toBeNull();
    });

    it('returns null when options list is empty', () => {
      expect(parseAskAnswer('1', [])).toBeNull();
    });
  });

  it('hydrates workspaces from config.workspaces on first boot', async () => {
    const daemon = await bootstrapDaemon({
      home,
      startAdapters: false,
      startIpc: false,
      startHealth: false,
      logger: silentLogger,
    });
    try {
      const ws = daemon.workspaces.findByWorkdir(home);
      expect(ws).toBeDefined();
      expect(ws!.name).toBe('test');
    } finally {
      await daemon.shutdown();
    }
  });
});
