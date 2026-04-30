// tests/im/command-parser.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatch, registerCommand, resetRegistryForTests, listCommands, parseQuotedTail, parseFlags,
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
      role: ['admin', 'operator', 'observer'],
      async run(_ctx, args) { captured = args; },
    });
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/echo foo bar', 'admin');
    expect(captured).toEqual(['foo', 'bar']);
    expect(replies).toEqual([]);
  });

  it('replies with unknown-command message for unknown name', async () => {
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/nope', 'admin');
    expect(replies[0]).toMatch(/未知命令/);
  });

  it('role-gates — denies if userRole not in def.role', async () => {
    registerCommand({
      name: 'grant', role: ['admin'],
      async run() { /* never runs */ },
    });
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/grant u1 admin', 'operator');
    expect(replies[0]).toMatch(/无权限/);
  });

  it('resolves alias back to the same def', async () => {
    let hit = 0;
    registerCommand({
      name: 'help', aliases: ['h', '?'], role: ['observer'],
      async run() { hit += 1; },
    });
    const { ctx } = buildCtx();
    await dispatch(ctx, '/h', 'observer');
    await dispatch(ctx, '/?', 'observer');
    expect(hit).toBe(2);
  });

  it('listCommands dedupes across aliases', () => {
    registerCommand({ name: 'a', aliases: ['aa'], role: ['admin'], async run() { /* */ } });
    registerCommand({ name: 'b', role: ['admin'], async run() { /* */ } });
    expect(listCommands().length).toBe(2);
  });

  it('reports run() throw via reply', async () => {
    registerCommand({
      name: 'boom', role: ['admin'],
      async run() { throw new Error('kaboom'); },
    });
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/boom', 'admin');
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
    registerCommand({ name: 'foo', role: ['admin'], async run() { /* */ } });
    const { logger, logs } = makeTestLogger();
    const { ctx } = buildCtx();
    await dispatch(ctx, '/foo', 'admin', logger);
    const msgs = logs.map((l) => l.msg);
    expect(msgs).toContain('command dispatch start');
    expect(msgs).toContain('command done');
  });

  it('replies and logs on unknown command', async () => {
    const { logger, logs } = makeTestLogger();
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/nonexistent', 'admin', logger);
    expect(logs.some((l) => l.msg === 'command unknown')).toBe(true);
    expect(replies[0]).toContain('未知命令');
  });

  it('logs and replies when role is denied', async () => {
    registerCommand({ name: 'admin-only', role: ['admin'], async run() { /* */ } });
    const { logger, logs } = makeTestLogger();
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/admin-only', 'observer', logger);
    expect(logs.some((l) => l.msg === 'command denied')).toBe(true);
    expect(replies[0]).toMatch(/无权限/);
  });

  it('logs error and replies when run() throws', async () => {
    registerCommand({
      name: 'kaboom', role: ['admin'],
      async run() { throw new Error('boom!'); },
    });
    const { logger, logs } = makeTestLogger();
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/kaboom', 'admin', logger);
    expect(logs.some((l) => l.level === 'error' && l.msg === 'command failed')).toBe(true);
    expect(replies[0]).toMatch(/boom!/);
  });

  it('replies in Chinese on empty command (just /)', async () => {
    resetRegistryForTests();
    const { ctx, replies } = buildCtx();
    const { logger } = makeTestLogger();
    await dispatch(ctx, '/', 'admin', logger);
    expect(replies[0]).toContain('空命令');
  });

  it('safeReply retries once when first reply throws', async () => {
    registerCommand({
      name: 'broken', role: ['admin'],
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
    await dispatch(ctx, '/broken', 'admin', logger);
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
    await dispatch(ctx, '/nonexistent', 'admin', logger);
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
    await dispatch(ctx, '/nonexistent', 'admin', logger);
    expect(logs.some((l) => l.level === 'warn' && l.msg === 'reply retry')).toBe(true);
    const failedLog = logs.find((l) => l.level === 'error' && l.msg === 'reply failed');
    expect(failedLog).toBeDefined();
    expect(failedLog?.data).toMatchObject({ reason: 'always fail' });
  });
});
