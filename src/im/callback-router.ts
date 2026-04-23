// src/im/callback-router.ts
//
// Callback-data router for IM inline buttons (spec §8 + §13.4). Parses
// `callbackData` strings emitted by renderers and routes the resolution
// back into the appropriate subsystem:
//
//   perm:<verb>:<sid>:<reqId>        → PermissionBroker.resolve
//   ask:<optIdx>:<sid>:<reqId>       → AskUserQuestionBroker.resolve
//   elic:submit:<sid>:<reqId>        → ElicitationBroker.resolve accept
//   elic:cancel:<sid>:<reqId>        → ElicitationBroker.resolve decline
//   elic:open:<sid>:<reqId>          → Discord-only modal-show shim
//   suggest:<sid>:<sugId>            → SessionManager.get(sid).sendInput
//   queue:cancel:<sid>:<itemId>      → session.queue.cancel
//   budget:override:<sid>:<usd>      → (TODO T9) BudgetGuard.extend via session
//   takeback:<sid>                   → SessionManager.resumeLocal
//
// For any `perm:` / `ask:` / `elic:` / `queue:` callback whose session is
// not currently live in the SessionManager, we walk the spec §13.4 stale-
// permission recovery path: if meta exists, attempt resume and edit the
// stale card to an informational message; else edit to "session invalidated".
//
// Short-alias prefix resolution: sid may be either the full sdkSessionId or
// a short alias prefix (SessionManager.getByPrefix).

import type { SessionManager } from '../session/manager.js';
import type { PermissionBroker } from '../permission/broker.js';
import type { AskUserQuestionBroker } from '../permission/ask-broker.js';
import type { ElicitationBroker } from '../permission/elicitation-broker.js';
import type { LocalSession } from '../session/local-session.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { PermissionDecision } from '../runtime/types.js';

export interface CallbackRouterDeps {
  sessionManager: SessionManager;
  permissionBroker: PermissionBroker;
  askBroker: AskUserQuestionBroker;
  elicitationBroker: ElicitationBroker;
  /**
   * Optional adapters map for `elic:open:` (Discord modal) and for stale-
   * card edits. T9 wires this; tests pass stubs.
   */
  adapters?: Partial<Record<import('../workspace/bindings.js').ChannelType, PlatformAdapter>>;
  /**
   * Optional callback invoked when Discord needs to show a pending modal
   * for an elicitation. The real wiring requires a raw Discord Interaction
   * instance; the router only hands off the modal spec + requestId.
   */
  showDiscordModal?: (
    requestId: string,
    modal: { title: string; fields: unknown[] },
  ) => Promise<void>;
}

export interface CallbackContext {
  /** Raw callbackData string from the inbound event. */
  data: string;
  /** User who clicked. Forwarded to resolveByUserId for audit. */
  userId: string;
  /** Chat where the button lived — used for stale-card edits. */
  chatId: string;
  /** Message id holding the stale button, for spec §13.4 edits. */
  messageId?: string;
  /** Platform that delivered the click. */
  channelType: import('../workspace/bindings.js').ChannelType;
}

export type CallbackOutcome =
  | { kind: 'unknown'; reason: string }
  | { kind: 'handled'; action: string }
  | { kind: 'stale'; action: 'invalidated' | 'resumed_waiting' | 'already_resolved' };

/**
 * Parse `callbackData` into its kind + parts. Returns null when the
 * string does not match any known kind — caller treats as no-op.
 */
export function parseCallbackData(data: string): { kind: string; parts: string[] } | null {
  if (!data) return null;
  const parts = data.split(':');
  if (parts.length < 1) return null;
  const kind = parts[0]!;
  return { kind, parts: parts.slice(1) };
}

export class CallbackRouter {
  constructor(private readonly deps: CallbackRouterDeps) {}

  async route(ctx: CallbackContext): Promise<CallbackOutcome> {
    const parsed = parseCallbackData(ctx.data);
    if (!parsed) return { kind: 'unknown', reason: 'empty' };
    const { kind, parts } = parsed;

    switch (kind) {
      case 'perm':
        return this.handlePerm(parts, ctx);
      case 'ask':
        return this.handleAsk(parts, ctx);
      case 'elic':
        return this.handleElic(parts, ctx);
      case 'suggest':
        return this.handleSuggest(parts, ctx);
      case 'queue':
        return this.handleQueue(parts, ctx);
      case 'budget':
        return this.handleBudget(parts, ctx);
      case 'takeback':
        return this.handleTakeback(parts, ctx);
      default:
        return { kind: 'unknown', reason: `unknown kind: ${kind}` };
    }
  }

  // ---- Permission --------------------------------------------------------

  private async handlePerm(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    // `<verb>:<sid>:<reqId>`
    const [verb, sidRaw, ...reqParts] = parts;
    if (!verb || !sidRaw || reqParts.length === 0) {
      return { kind: 'unknown', reason: 'perm:malformed' };
    }
    const reqId = reqParts.join(':');
    const decision = permVerbToDecision(verb);
    if (!decision) return { kind: 'unknown', reason: `perm:bad-verb:${verb}` };

    const sid = this.resolveSid(sidRaw);
    if (!sid) {
      return this.handleStaleSession(sidRaw, ctx);
    }
    const ok = this.deps.permissionBroker.resolve(sid, reqId, decision.decision, ctx.userId);
    if (!ok) {
      // Pending not found — may have already been resolved by another operator.
      return { kind: 'stale', action: 'already_resolved' };
    }
    return {
      kind: 'handled',
      action: `perm:${verb}` + (decision.learn ? ':learn' : ''),
    };
  }

  // ---- AskUserQuestion ---------------------------------------------------

  private async handleAsk(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    // Legacy form in frontend.ts: `ask:<requestId>:<optIdx>` (no sid). We
    // accept both shapes — new form is `ask:<optIdx>:<sid>:<reqId>`.
    let optIdx: number;
    let sidRaw: string | undefined;
    let reqId: string;
    if (parts.length === 2) {
      // frontend v1: ask:<reqId>:<optIdx>
      reqId = parts[0]!;
      optIdx = Number(parts[1]);
      sidRaw = undefined;
    } else if (parts.length >= 3) {
      // spec v1: ask:<optIdx>:<sid>:<reqId...>
      optIdx = Number(parts[0]);
      sidRaw = parts[1];
      reqId = parts.slice(2).join(':');
    } else {
      return { kind: 'unknown', reason: 'ask:malformed' };
    }

    if (!Number.isFinite(optIdx)) return { kind: 'unknown', reason: 'ask:bad-idx' };
    const sid = sidRaw ? this.resolveSid(sidRaw) : this.findSessionForAskRequest(reqId);
    if (!sid) return this.handleStaleSession(sidRaw ?? '', ctx);

    const req = this.deps.askBroker.pendingFor(sid).find((r) => r.id === reqId);
    if (!req) return { kind: 'stale', action: 'already_resolved' };
    const chosen = req.options[optIdx];
    if (!chosen) return { kind: 'unknown', reason: 'ask:idx-out-of-range' };

    const ok = this.deps.askBroker.resolve(sid, reqId, [chosen], ctx.userId);
    return ok ? { kind: 'handled', action: 'ask:resolved' } : { kind: 'stale', action: 'already_resolved' };
  }

  // ---- Elicitation -------------------------------------------------------

  private async handleElic(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    // elic:<verb>:<sid>:<reqId>
    const [verb, sidRaw, ...reqParts] = parts;
    if (!verb || !sidRaw || reqParts.length === 0) {
      return { kind: 'unknown', reason: 'elic:malformed' };
    }
    const reqId = reqParts.join(':');
    const sid = this.resolveSid(sidRaw);

    if (verb === 'open') {
      // Discord modal handoff.
      if (!sid) return this.handleStaleSession(sidRaw, ctx);
      const discordAdapter = this.deps.adapters?.discord as
        | (PlatformAdapter & { pendingModals?: Map<string, { title: string; fields: unknown[] }> })
        | undefined;
      const modal = discordAdapter?.pendingModals?.get(reqId);
      if (!modal) return { kind: 'unknown', reason: 'elic:open:no-modal' };
      if (this.deps.showDiscordModal) {
        await this.deps.showDiscordModal(reqId, modal);
      }
      return { kind: 'handled', action: 'elic:open' };
    }

    if (!sid) return this.handleStaleSession(sidRaw, ctx);

    if (verb === 'submit') {
      const ok = this.deps.elicitationBroker.resolve(
        sid,
        reqId,
        { action: 'accept', content: {} },
        ctx.userId,
      );
      return ok ? { kind: 'handled', action: 'elic:submit' } : { kind: 'stale', action: 'already_resolved' };
    }
    if (verb === 'cancel') {
      const ok = this.deps.elicitationBroker.resolve(
        sid,
        reqId,
        { action: 'decline' },
        ctx.userId,
      );
      return ok ? { kind: 'handled', action: 'elic:cancel' } : { kind: 'stale', action: 'already_resolved' };
    }
    return { kind: 'unknown', reason: `elic:bad-verb:${verb}` };
  }

  // ---- Suggestion -------------------------------------------------------

  private async handleSuggest(parts: string[], _ctx: CallbackContext): Promise<CallbackOutcome> {
    // suggest:<sid>:<suggestionId>  OR  suggest:<sid>:<text...>
    const [sidRaw, ...rest] = parts;
    if (!sidRaw || rest.length === 0) return { kind: 'unknown', reason: 'suggest:malformed' };
    const sid = this.resolveSid(sidRaw);
    if (!sid) return { kind: 'stale', action: 'invalidated' };
    const session = this.deps.sessionManager.get(sid);
    if (!session || session.kind !== 'local') return { kind: 'stale', action: 'invalidated' };
    const text = rest.join(':');
    try { await (session as LocalSession).sendInput(text, 'im'); }
    catch { return { kind: 'unknown', reason: 'suggest:sendInput-failed' }; }
    return { kind: 'handled', action: 'suggest:sent' };
  }

  // ---- Queue ------------------------------------------------------------

  private async handleQueue(parts: string[], _ctx: CallbackContext): Promise<CallbackOutcome> {
    // queue:cancel:<sid>:<itemId>
    const [verb, sidRaw, ...rest] = parts;
    if (verb !== 'cancel' || !sidRaw || rest.length === 0) {
      return { kind: 'unknown', reason: 'queue:malformed' };
    }
    const itemId = rest.join(':');
    const sid = this.resolveSid(sidRaw);
    if (!sid) return { kind: 'stale', action: 'invalidated' };
    const session = this.deps.sessionManager.get(sid);
    if (!session || session.kind !== 'local') return { kind: 'stale', action: 'invalidated' };
    const ok = (session as LocalSession).queue.cancel(itemId);
    return ok ? { kind: 'handled', action: 'queue:cancel' } : { kind: 'stale', action: 'already_resolved' };
  }

  // ---- Budget -----------------------------------------------------------

  private async handleBudget(parts: string[], _ctx: CallbackContext): Promise<CallbackOutcome> {
    // budget:override:<sid>:<usd>
    const [verb, sidRaw, usdRaw] = parts;
    if (verb !== 'override' || !sidRaw || !usdRaw) {
      return { kind: 'unknown', reason: 'budget:malformed' };
    }
    const usd = Number(usdRaw);
    if (!Number.isFinite(usd) || usd <= 0) return { kind: 'unknown', reason: 'budget:bad-usd' };
    const sid = this.resolveSid(sidRaw);
    if (!sid) return { kind: 'stale', action: 'invalidated' };
    const session = this.deps.sessionManager.get(sid);
    if (!session || session.kind !== 'local') return { kind: 'stale', action: 'invalidated' };
    // BudgetGuard is not publicly exposed on LocalSession. Expose a setter
    // here via the well-known `any` — TODO(T9) add a proper `extendBudget`
    // method on LocalSession.
    const maybe = session as unknown as { budgetGuard?: { extend: (u: number) => void } };
    maybe.budgetGuard?.extend(usd);
    return { kind: 'handled', action: `budget:override:+${usd}` };
  }

  // ---- Takeback ---------------------------------------------------------

  private async handleTakeback(parts: string[], _ctx: CallbackContext): Promise<CallbackOutcome> {
    const [sidRaw] = parts;
    if (!sidRaw) return { kind: 'unknown', reason: 'takeback:malformed' };
    const sid = this.resolveSid(sidRaw);
    if (sid) {
      const live = this.deps.sessionManager.get(sid);
      if (live) return { kind: 'handled', action: 'takeback:already-live' };
    }
    const target = sid ?? sidRaw;
    const resumed = await this.deps.sessionManager.resumeLocal(target).catch(() => null);
    return resumed
      ? { kind: 'handled', action: 'takeback:resumed' }
      : { kind: 'stale', action: 'invalidated' };
  }

  // ---- Helpers ---------------------------------------------------------

  private resolveSid(raw: string): string | null {
    // Exact match first.
    const exact = this.deps.sessionManager.get(raw);
    if (exact) return exact.id;
    // Prefix match.
    const pref = this.deps.sessionManager.getByPrefix(raw);
    return pref.resolved?.id ?? null;
  }

  private findSessionForAskRequest(reqId: string): string | null {
    // Scan live sessions for the pending ask. Expensive in the worst case
    // but pending counts are tiny in practice.
    for (const s of this.deps.sessionManager.listInfo('local')) {
      const pending = this.deps.askBroker.pendingFor(s.id);
      if (pending.some((r) => r.id === reqId)) return s.id;
    }
    return null;
  }

  /**
   * Spec §13.4 stale-permission recovery. Try to resume; if no meta, the
   * card is invalidated. Router only reports the outcome — the renderer
   * (session-header or permission-card) edits the button card accordingly
   * when it observes the subsequent broker event or session resume event.
   */
  private async handleStaleSession(sidRaw: string, _ctx: CallbackContext): Promise<CallbackOutcome> {
    if (!sidRaw) return { kind: 'stale', action: 'invalidated' };
    const resumed = await this.deps.sessionManager.resumeLocal(sidRaw).catch(() => null);
    return resumed
      ? { kind: 'stale', action: 'resumed_waiting' }
      : { kind: 'stale', action: 'invalidated' };
  }
}

function permVerbToDecision(verb: string): { decision: PermissionDecision; learn?: boolean } | null {
  switch (verb) {
    case 'allow': return { decision: 'allow' };
    case 'deny':  return { decision: 'deny' };
    case 'always': return { decision: 'allow_always' };
    case 'learn': return { decision: 'allow_always', learn: true };
    default: return null;
  }
}
