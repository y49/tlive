// src/im/commands/_shared.ts
//
// Common helpers re-used across command implementations. Kept small and
// dependency-light so each command file can stay at ≤30 LOC of actual
// logic.

import type { CommandContext } from '../command-parser.js';
import type { LocalSession } from '../../session/local-session.js';
import type { RemoteSession } from '../../session/remote-session.js';
import type { Workspace } from '../../workspace/config.js';

/**
 * Resolve the workspace bound to this chat. Replies + returns null when
 * none is registered.
 */
export function workspaceForChat(ctx: CommandContext): Workspace | null {
  return ctx.workspaceManager.findByChat(ctx.inbound.channelType, ctx.inbound.chatId) ?? null;
}

/**
 * Resolve the currently-active LocalSession for this chat. Per chat-level
 * isolation (spec §3), the session belongs to the binding for the inbound
 * (channelType, chatId), not to the workspace. Replies + returns null when
 * missing or remote.
 */
export async function activeLocalSession(ctx: CommandContext): Promise<LocalSession | null> {
  const ws = workspaceForChat(ctx);
  if (!ws) {
    await ctx.reply('This chat is not bound to a workspace. Send `/bind` (admin) to attach, or `/whoami` for guidance.');
    return null;
  }
  const activeId = ctx.workspaceManager.getActiveSessionIdForChat(
    ctx.inbound.channelType,
    ctx.inbound.chatId,
  );
  if (!activeId) { await ctx.reply('No active session for this chat.'); return null; }
  const session = ctx.sessionManager.get(activeId);
  if (!session) { await ctx.reply(`Active session ${activeId.slice(0, 8)} not found in manager.`); return null; }
  if (session.kind !== 'local') { await ctx.reply('Active session is remote; runtime controls are unavailable.'); return null; }
  return session as LocalSession;
}

/**
 * Resolve a session by short-alias prefix, with nice ambiguity message on
 * miss. Returns `null` when unresolvable and replies to the user.
 *
 * Options:
 * - `includeStopped` — when true, on a live-prefix miss (no ambiguous live
 *   matches) the caller is expected to attempt a meta-backed resume; the
 *   helper suppresses the "no match" reply and returns null silently so the
 *   caller can take over. Ambiguous live matches still short-circuit with a
 *   candidate-list reply (a stopped resume on an ambiguous prefix would be
 *   misleading).
 */
export async function resolveSessionArg(
  ctx: CommandContext,
  prefix: string,
  opts: { includeStopped?: boolean } = {},
): Promise<LocalSession | RemoteSession | null> {
  if (!prefix) { await ctx.reply('Missing session alias argument.'); return null; }
  const res = ctx.sessionManager.getByPrefix(prefix);
  if (res.resolved) return res.resolved as LocalSession | RemoteSession;
  if (res.ambiguous.length > 1) {
    const ids = res.ambiguous.map((s) => s.shortAlias).join(', ');
    await ctx.reply(`Ambiguous prefix '${prefix}'. Matches: ${ids}`);
    return null;
  }
  if (opts.includeStopped) {
    // Caller (e.g. /resume) will try resumeLocal against stopped meta; skip
    // the "no match" reply so the caller owns the failure path.
    return null;
  }
  await ctx.reply(`No session matches prefix '${prefix}'.`);
  return null;
}

/**
 * Extract `"quoted tail"` at the end of args — e.g.
 *   /rename abcd "my shiny title"
 *       head=['abcd'], quoted='my shiny title'
 */
export function parseQuoted(args: string[]): { head: string[]; quoted: string | null } {
  const joined = args.join(' ');
  const m = joined.match(/^(.*?)"([^"]*)"\s*$/);
  if (!m) return { head: args, quoted: null };
  const head = m[1]!.trim().split(/\s+/).filter((s) => s.length > 0);
  return { head, quoted: m[2] ?? null };
}

/** Short-id rendering — SDK ids are 36 chars; we print the first 8. */
export function shortOf(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}
