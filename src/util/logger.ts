// src/util/logger.ts
//
// Tiny structured logger used by the daemon. Writes newline-delimited JSON
// to stderr at default; callers may pipe to ~/.tlive/logs/daemon.log.
//
// Levels: debug < info < warn < error. Set via `TLIVE_LOG_LEVEL` env or
// `DaemonConfig.logLevel`. `child(...)` returns a logger with an appended
// context object so subsystems can tag their log lines.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  level: LogLevel;
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  child: (context: Record<string, unknown>) => Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Destination function. Default: `process.stderr.write`. */
  sink?: (line: string) => void;
  context?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level: LogLevel = opts.level ?? (process.env.TLIVE_LOG_LEVEL as LogLevel) ?? 'info';
  const sink = opts.sink ?? ((line) => process.stderr.write(line + '\n'));
  const baseContext = opts.context ?? {};

  function emit(l: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_RANK[l] < LEVEL_RANK[level]) return;
    const record = {
      ts: new Date().toISOString(),
      level: l,
      msg,
      ...baseContext,
      ...(fields ?? {}),
    };
    try { sink(JSON.stringify(record)); } catch { /* swallow logger errors */ }
  }

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child(ctx) { return createLogger({ level, sink, context: { ...baseContext, ...ctx } }); },
  };
}
