// tests/im/command-parser.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatch, registerCommand, resetRegistryForTests, listCommands, parseQuotedTail, parseFlags,
  validateRegistry,
  type CommandContext,
} from '../../src/im/command-parser.js';
import type { Logger } from '../../src/util/logger.js';
import { buildCtx } from './commands/_helpers.js';

interface CapturedLog { level: 'info' | 'warn' | 'error' | 'debug'; msg: string; data?: unknown }

function makeTestLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const make = (level: CapturedLog['level']) => (msg: string, data?: unknown) => {
    logs.push({ level, msg, data });
  };
  const logger: Logger = {
    level: 'info',
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    child() { return logger; },
  };
  return { logger, logs };
}

describe('command-parser', () => {
  beforeEach(() => resetRegistryForTests());

  it('dispatches to the right command + passes args', async () => {
    let captured: string[] | null = null;
    registerCommand({
      name: 'echo',
      async run(_ctx, args) { captured = args; },
    });
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/echo foo bar');
    expect(captured).toEqual(['foo', 'bar']);
    expect(replies).toEqual([]);
  });

  it('replies with unknown-command message for unknown name', async () => {
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/nope');
    expect(replies[0]).toMatch(/未知命令/);
  });

  it('chat-trust: any user can run any registered command (no role gate)', async () => {
    let ran = false;
    registerCommand({
      name: 'cmd',
      async run() { ran = true; },
    });
    const { ctx } = buildCtx();
    await dispatch(ctx, '/cmd');
    expect(ran).toBe(true);
  });

  it('resolves alias back to the same def', async () => {
    let hit = 0;
    registerCommand({
      name: 'help', aliases: ['h', '?'],
      async run() { hit += 1; },
    });
    const { ctx } = buildCtx();
    await dispatch(ctx, '/h');
    await dispatch(ctx, '/?');
    expect(hit).toBe(2);
  });

  it('listCommands dedupes across aliases', () => {
    registerCommand({ name: 'a', aliases: ['aa'], async run() { /* */ } });
    registerCommand({ name: 'b', async run() { /* */ } });
    expect(listCommands().length).toBe(2);
  });

  it('reports run() throw via reply', async () => {
    registerCommand({
      name: 'boom',
      async run() { throw new Error('kaboom'); },
    });
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/boom');
    expect(replies[0]).toMatch(/kaboom/);
  });

  it('parseQuotedTail extracts trailing quoted string', () => {
    const r = parseQuotedTail(['abcd', '"my', 'shiny', 'title"']);
    expect(r.head).toEqual(['abcd']);
    expect(r.quoted).toBe('my shiny title');
  });

  it('parseFlags splits --flag --key=value from positional', () => {
    const r = parseFlags(['--global', '--format=json', 'a', 'b']);
    expect(r.flags).toEqual({ global: true, format: 'json' });
    expect(r.positional).toEqual(['a', 'b']);
  });
});

describe('dispatch logging', () => {
  beforeEach(() => resetRegistryForTests());

  it('logs command start and done with name', async () => {
    registerCommand({ name: 'foo', async run() { /* */ } });
    const { logger, logs } = makeTestLogger();
    const { ctx } = buildCtx();
    await dispatch(ctx, '/foo', logger);
    const msgs = logs.map((l) => l.msg);
    expect(msgs).toContain('command dispatch start');
    expect(msgs).toContain('command done');
  });

  it('replies and logs on unknown command', async () => {
    const { logger, logs } = makeTestLogger();
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/nonexistent', logger);
    expect(logs.some((l) => l.msg === 'command unknown')).toBe(true);
    expect(replies[0]).toContain('未知命令');
  });

  it('logs error and replies when run() throws', async () => {
    registerCommand({
      name: 'kaboom',
      async run() { throw new Error('boom!'); },
    });
    const { logger, logs } = makeTestLogger();
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/kaboom', logger);
    expect(logs.some((l) => l.level === 'error' && l.msg === 'command failed')).toBe(true);
    expect(replies[0]).toMatch(/boom!/);
  });

  it('replies in Chinese on empty command (just /)', async () => {
    resetRegistryForTests();
    const { ctx, replies } = buildCtx();
    const { logger } = makeTestLogger();
    await dispatch(ctx, '/', logger);
    expect(replies[0]).toContain('空命令');
  });

  it('safeReply retries once when first reply throws', async () => {
    registerCommand({
      name: 'broken',
      async run(c) { await c.reply('test'); },
    });
    let calls = 0;
    const ctx: CommandContext = {
      inbound: {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        kind: 'message', at: Date.now(), messageId: 'm1',
      } as never,
      userId: 'u1',
      sessionManager: {} as never,
      workspaceManager: {} as never,
      permissionBroker: {} as never,
      askBroker: {} as never,
      elicitationBroker: {} as never,
      reply: async () => {
        calls++;
        if (calls === 1) throw new Error('first fail');
      },
    };
    const { logger } = makeTestLogger();
    // /broken calls reply once (throws), then dispatch catches and uses safeReply
    // which calls reply again (call 2 succeeds with the failure message).
    await dispatch(ctx, '/broken', logger);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('logs reply retry warn when first reply throws but second succeeds', async () => {
    let calls = 0;
    const ctx: CommandContext = {
      inbound: {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        kind: 'message', at: Date.now(), messageId: 'm1',
      } as never,
      userId: 'u1',
      sessionManager: {} as never,
      workspaceManager: {} as never,
      permissionBroker: {} as never,
      askBroker: {} as never,
      elicitationBroker: {} as never,
      reply: async () => {
        calls++;
        if (calls === 1) throw new Error('first fail');
        // second call succeeds
      },
    };
    const { logger, logs } = makeTestLogger();
    // unknown command → safeReply → first throws → log warn → second succeeds
    await dispatch(ctx, '/nonexistent', logger);
    expect(calls).toBe(2);
    const retryLog = logs.find((l) => l.level === 'warn' && l.msg === 'reply retry');
    expect(retryLog).toBeDefined();
    expect(retryLog?.data).toMatchObject({ reason: 'first fail' });
    expect(logs.some((l) => l.level === 'error' && l.msg === 'reply failed')).toBe(false);
  });

  it('logs reply failed error when both replies throw', async () => {
    const ctx: CommandContext = {
      inbound: {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        kind: 'message', at: Date.now(), messageId: 'm1',
      } as never,
      userId: 'u1',
      sessionManager: {} as never,
      workspaceManager: {} as never,
      permissionBroker: {} as never,
      askBroker: {} as never,
      elicitationBroker: {} as never,
      reply: async () => {
        throw new Error('always fail');
      },
    };
    const { logger, logs } = makeTestLogger();
    await dispatch(ctx, '/nonexistent', logger);
    expect(logs.some((l) => l.level === 'warn' && l.msg === 'reply retry')).toBe(true);
    const failedLog = logs.find((l) => l.level === 'error' && l.msg === 'reply failed');
    expect(failedLog).toBeDefined();
    expect(failedLog?.data).toMatchObject({ reason: 'always fail' });
  });
});

describe('validateRegistry', () => {
  it('returns no issues for valid commands', () => {
    resetRegistryForTests();
    registerCommand({ name: 'foo', async run() {} });
    expect(validateRegistry()).toEqual([]);
  });

  it('detects missing run function', () => {
    resetRegistryForTests();
    registerCommand({ name: 'broken', run: undefined as never });
    const issues = validateRegistry();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.name).toBe('broken');
    expect(issues[0]!.message).toContain('run');
  });

  it('detects uppercase name', () => {
    resetRegistryForTests();
    registerCommand({ name: 'BadCase', async run() {} });
    const issues = validateRegistry();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('lowercase');
  });

  it('aliases do not double-report (each def counted once)', () => {
    resetRegistryForTests();
    // Provide a valid command except for the uppercase name issue
    registerCommand({ name: 'BadCase2', aliases: ['x', 'y', 'z'], async run() {} });
    // Same broken def registered under 4 keys; should report once not 4 times
    expect(validateRegistry()).toHaveLength(1);
  });
});
