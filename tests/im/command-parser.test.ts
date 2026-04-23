// tests/im/command-parser.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatch, registerCommand, resetRegistryForTests, listCommands, parseQuotedTail, parseFlags,
} from '../../src/im/command-parser.js';
import { buildCtx } from './commands/_helpers.js';

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

  it('replies "Unknown command" for unknown name', async () => {
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/nope', 'admin');
    expect(replies[0]).toMatch(/Unknown command/);
  });

  it('role-gates — denies if userRole not in def.role', async () => {
    registerCommand({
      name: 'grant', role: ['admin'],
      async run() { /* never runs */ },
    });
    const { ctx, replies } = buildCtx();
    await dispatch(ctx, '/grant u1 admin', 'operator');
    expect(replies[0]).toMatch(/don't have permission/);
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
