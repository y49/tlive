// src/im/command-parser.ts
//
// Central slash-command dispatcher for the IM surface (spec §8). Each
// command file under `src/im/commands/` exports a `CommandDef`; this file
// owns the registry, the `CommandContext` shape, and the dispatch entry
// point. T9's daemon bootstrap wires `dispatch()` to the PlatformAdapter's
// `onInbound` callback.
//
// Design:
// - Registry is a flat Map<string, CommandDef>. Aliases resolve to the same
//   def (stored under each alias key). `listCommands()` dedupes via Set.
// - Role gating: CommandContext carries the caller's role; dispatch rejects
//   with a friendly message when the role is not in `def.role`.
// - Parsing: we split on whitespace for simple commands; complex commands
//   (e.g. `/rename <alias> "<title>"`) do their own quote handling inside
//   `run()` via `parseQuotedTail` helpers.

import type { Role } from '../permission/roles.js';
import type { InboundEvent, ReplyMarkup } from '../platform/types.js';
import type { SessionManager } from '../session/manager.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { PermissionBroker } from '../permission/broker.js';
import type { AskUserQuestionBroker } from '../permission/ask-broker.js';
import type { ElicitationBroker } from '../permission/elicitation-broker.js';
import type { CostRollupStore } from '../cost/rollups.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { PolicyStore } from '../permission/policy-store.js';
import type { SessionPersistence } from '../session/persistence.js';
import type { AttachmentStore } from '../attachment/store.js';
import { createLogger, type Logger } from '../util/logger.js';

export interface CommandContext {
  /** The inbound event that carried the command text. */
  inbound: InboundEvent;
  /** Operator id (raw user id string) — for audit + resolveByUserId. */
  userId: string;
  sessionManager: SessionManager;
  workspaceManager: WorkspaceManager;
  permissionBroker: PermissionBroker;
  askBroker: AskUserQuestionBroker;
  elicitationBroker: ElicitationBroker;
  /** Resolve a PolicyStore for a given workspace. T9 wires a real provider. */
  policyStoreFor?: (workspaceId: string) => PolicyStore | undefined;
  /** Optional rollup store for `/cost`. */
  rollupStore?: CostRollupStore;
  /** Optional registry for `/mcp` subcommands. */
  mcpRegistry?: McpRegistry;
  /** Optional persistence for /export + /search reading jsonl history. */
  persistence?: SessionPersistence;
  /** Optional attachment store for /attach-last. */
  attachments?: AttachmentStore;
  /** Reply text back to the user; T9 wires this to the resolved adapter. */
  reply: (text: string, opts?: { replyMarkup?: ReplyMarkup }) => Promise<void>;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  /** Required role(s) to invoke. Empty array denies everyone. */
  role: Role[];
  /** Optional short description for autocomplete / help listing. */
  description?: string;
  run(ctx: CommandContext, args: string[]): Promise<void>;
}

const registry = new Map<string, CommandDef>();

export function registerCommand(def: CommandDef): void {
  registry.set(def.name, def);
  for (const a of def.aliases ?? []) registry.set(a, def);
}

export function listCommands(): CommandDef[] {
  return [...new Set(registry.values())];
}

export function findCommand(name: string): CommandDef | undefined {
  return registry.get(name);
}

/** Test helper — wipes registry so tests don't bleed into each other. */
export function resetRegistryForTests(): void {
  registry.clear();
}

export async function dispatch(
  ctx: CommandContext,
  rawText: string,
  userRole: Role,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? createLogger({ level: 'error', sink: () => undefined });
  const [nameRaw, ...args] = rawText.replace(/^\/+/, '').trim().split(/\s+/);
  const name = (nameRaw ?? '').toLowerCase();

  log.info('command dispatch start', {
    name, args, userRole,
    chatId: ctx.inbound.chatId,
    userId: ctx.userId,
  });

  if (!name) {
    await safeReply(ctx, '空命令。发 /help 看全部。', log);
    return;
  }
  const def = registry.get(name);
  if (!def) {
    log.info('command unknown', { name });
    await safeReply(ctx, `未知命令: /${name}。发 /help 看全部。`, log);
    return;
  }
  if (!def.role.includes(userRole)) {
    log.info('command denied', { name, userRole });
    await safeReply(ctx, `无权限使用 /${def.name}`, log);
    return;
  }
  try {
    await def.run(ctx, args);
    log.info('command done', { name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('command failed', { name, reason: msg });
    await safeReply(ctx, `❌ /${def.name} 失败: ${msg}`, log);
  }
}

async function safeReply(ctx: CommandContext, text: string, log: Logger): Promise<void> {
  try {
    await ctx.reply(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('reply retry', { reason });
    try {
      await ctx.reply(text);
    } catch (err2) {
      const reason2 = err2 instanceof Error ? err2.message : String(err2);
      log.error('reply failed', { reason: reason2 });
    }
  }
}

// ---- Helpers for command implementations ---------------------------------

/**
 * Extract a quoted tail — handles `/rename abcd "my title"` style. Returns
 * `{ head, quoted }` where head is the leading non-quoted words and quoted
 * is the (possibly empty) content inside the first `"..."` pair.
 */
export function parseQuotedTail(args: string[]): { head: string[]; quoted: string | null } {
  const joined = args.join(' ');
  const m = joined.match(/^(.*?)"([^"]*)"\s*$/);
  if (!m) return { head: args, quoted: null };
  const head = m[1]!.trim().split(/\s+/).filter((s) => s.length > 0);
  return { head, quoted: m[2] ?? null };
}

/**
 * Parse `--key=value` and `--flag` tokens from a command line. Anything
 * that doesn't start with `--` falls into `positional`.
 */
export function parseFlags(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export interface RegistryIssue {
  name: string;
  message: string;
}

export function validateRegistry(): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const seen = new Set<CommandDef>();
  for (const def of registry.values()) {
    if (seen.has(def)) continue;
    seen.add(def);
    if (typeof def.run !== 'function') {
      issues.push({ name: def.name, message: 'run is not a function' });
    }
    if (!Array.isArray(def.role) || def.role.length === 0) {
      issues.push({ name: def.name, message: 'role must be non-empty array' });
    }
    if (!def.name || def.name !== def.name.toLowerCase()) {
      issues.push({ name: def.name, message: 'name must be non-empty lowercase' });
    }
  }
  return issues;
}

