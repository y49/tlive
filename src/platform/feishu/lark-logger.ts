// src/platform/feishu/lark-logger.ts
//
// Adapt the daemon's structured Logger to the lark SDK's LoggerLike shape.
// Lark WSClient and EventDispatcher take an `info/warn/error/debug` quartet
// (varargs string-style); we forward each call as a single Logger entry
// tagged `feishu/ws` with the joined message in `fields.msg`. This makes
// ws status visible in `tlive daemon-logs` without polluting the structured
// log schema.

import type { Logger } from '../../util/logger.js';

type LarkLogFn = (...args: unknown[]) => void;

export interface LarkLoggerLike {
  info: LarkLogFn;
  warn: LarkLogFn;
  error: LarkLogFn;
  debug: LarkLogFn;
  trace: LarkLogFn;
}

function format(args: unknown[]): string {
  return args.map((a) => String(a)).join(' ');
}

export function larkLoggerAdapter(logger: Logger): LarkLoggerLike {
  return {
    info:  (...args) => logger.info('feishu/ws',  { msg: format(args) }),
    warn:  (...args) => logger.warn('feishu/ws',  { msg: format(args) }),
    error: (...args) => logger.error('feishu/ws', { msg: format(args) }),
    debug: (...args) => logger.debug('feishu/ws', { msg: format(args) }),
    trace: (...args) => logger.debug('feishu/ws', { msg: format(args) }),
  };
}
