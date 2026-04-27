import { describe, it, expect } from 'vitest';
import { larkLoggerAdapter } from '../../../src/platform/feishu/lark-logger.js';
import type { Logger } from '../../../src/util/logger.js';

function fakeLogger(): Logger & { calls: Array<{ level: string; msg: string; fields: unknown }> } {
  const calls: Array<{ level: string; msg: string; fields: unknown }> = [];
  const lg = {
    level: 'debug' as const,
    info:  (m: string, f?: Record<string, unknown>) => calls.push({ level: 'info',  msg: m, fields: f }),
    warn:  (m: string, f?: Record<string, unknown>) => calls.push({ level: 'warn',  msg: m, fields: f }),
    error: (m: string, f?: Record<string, unknown>) => calls.push({ level: 'error', msg: m, fields: f }),
    debug: (m: string, f?: Record<string, unknown>) => calls.push({ level: 'debug', msg: m, fields: f }),
    child: () => fakeLogger(),
    calls,
  };
  return lg as never;
}

describe('larkLoggerAdapter', () => {
  it('routes info() into daemon Logger.info under feishu/ws context', () => {
    const lg = fakeLogger();
    larkLoggerAdapter(lg).info('[ws]', 'ws connect success');
    expect(lg.calls).toEqual([
      { level: 'info', msg: 'feishu/ws', fields: { msg: '[ws] ws connect success' } },
    ]);
  });

  it('routes warn(), error(), debug()', () => {
    const lg = fakeLogger();
    const a = larkLoggerAdapter(lg);
    a.warn('a');
    a.error('b', 'c');
    a.debug('d');
    expect(lg.calls.map((c) => c.level)).toEqual(['warn', 'error', 'debug']);
  });

  it('coerces non-string args to string via join', () => {
    const lg = fakeLogger();
    larkLoggerAdapter(lg).info('[ws]', { x: 1 });
    expect(lg.calls[0].fields).toEqual({ msg: '[ws] [object Object]' });
  });
});
