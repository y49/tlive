// tests/daemon/ask-relay.test.ts
//
// Bug B regression: AskUserQuestion plain-text answer relay.
//
// When the agent has a pending ask on the chat's active session, a plain
// text inbound like "2" or "tea" should resolve the question rather than
// being routed into lazyResumeOrCreate as a new prompt.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapDaemon } from '../../src/daemon/bootstrap.js';
import { FakeAdapter } from '../im/fake-adapter.js';
import { createLogger } from '../../src/util/logger.js';
import type { AskUserQuestionRequest } from '../../src/runtime/types.js';

const silentLogger = createLogger({ level: 'error', sink: () => undefined });

describe('handleInbound — AskUserQuestion answer relay', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tlive-ask-relay-'));
    mkdirSync(home, { recursive: true });
    // Workspace + telegram binding so chatId 555 maps to a workspace.
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      version: '1',
      workspaces: [{ name: 'ws', workdir: home, adminUserId: 'u1' }],
      channels: { telegram: { token: 'fake', chatId: '555' } },
    }), 'utf8');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('resolves a pending ask when the user replies with the option index', async () => {
    const fake = new FakeAdapter('telegram');
    const handle = await bootstrapDaemon({
      home,
      startAdapters: true,
      startIpc: false,
      startHealth: false,
      logger: silentLogger,
      adapterFactory: (ct) => (ct === 'telegram' ? fake : null),
    });
    try {
      // Bind the workspace's active session to a synthetic id.
      const ws = handle.workspaces.findByChat('telegram', '555');
      expect(ws).toBeDefined();
      const sessionId = 'session-abc';
      handle.workspaces.bindActiveSession(ws!.id, sessionId);

      // Stage a pending question on that session.
      let resolved: string[] | null = null;
      const req: AskUserQuestionRequest = {
        id: 'ask-1',
        prompt: '你想喝什么饮料?',
        options: [{ label: '咖啡' }, { label: '茶' }, { label: '可乐' }],
        resolve: (chosen) => { resolved = chosen; },
      };
      handle.askBroker.issue(sessionId, req);

      // User replies "2" — should map to options[1] ("茶") and resolve.
      fake.emit({
        channelType: 'telegram',
        chatId: '555',
        messageId: 'm-1',
        userId: 'u1',
        text: '2',
        kind: 'message',
        at: Date.now(),
      });

      // Allow the async handleInbound chain to settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(resolved).toEqual(['茶']);
      // After resolve the broker should have no pending entries for this session.
      expect(handle.askBroker.pendingFor(sessionId)).toHaveLength(0);
    } finally {
      await handle.shutdown();
    }
  });

  it('falls through to lazyResumeOrCreate when reply does not match any option', async () => {
    const fake = new FakeAdapter('telegram');
    const handle = await bootstrapDaemon({
      home,
      startAdapters: true,
      startIpc: false,
      startHealth: false,
      logger: silentLogger,
      adapterFactory: (ct) => (ct === 'telegram' ? fake : null),
    });
    try {
      const ws = handle.workspaces.findByChat('telegram', '555');
      const sessionId = 'session-xyz';
      handle.workspaces.bindActiveSession(ws!.id, sessionId);

      let resolved: string[] | null = null;
      handle.askBroker.issue(sessionId, {
        id: 'ask-2',
        prompt: '你想喝什么?',
        options: [{ label: '咖啡' }, { label: '茶' }],
        resolve: (chosen) => { resolved = chosen; },
      });

      fake.emit({
        channelType: 'telegram',
        chatId: '555',
        messageId: 'm-2',
        userId: 'u1',
        text: 'something completely unrelated',
        kind: 'message',
        at: Date.now(),
      });

      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Ask still pending — relay declined.
      expect(resolved).toBeNull();
      expect(handle.askBroker.pendingFor(sessionId)).toHaveLength(1);
    } finally {
      await handle.shutdown();
    }
  });
});
