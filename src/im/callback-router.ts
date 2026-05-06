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
//   suggest:<sid>:<sugId>            → SessionManager.get(sid).sendInput
//   queue:cancel:<sid>:<itemId>      → session.queue.cancel
//   budget:override:<sid>:<usd>      → (TODO T9) BudgetGuard.extend via session
//   takeback:<sid>                   → SessionManager.resumeLocal
//
// For any `perm:` / `ask:` / `elic:` / `queue:` callback whose session is
// not currently live in the SessionManager, we walk the spec §13.4 stale-
// permission recovery path: if meta exists, attempt resume and edit the
// stale card to an informational message; else edit to "session invalidated".
// When `ctx.adapters` + `ctx.messageId` are wired, the router performs the
// stale-card edit directly via `adapters[channelType].edit(...)` so the old
// card reflects the outcome even if no subsequent broker event fires.
//
// `perm:learn` semantics: resolves the current request as `allow_always` AND
// (when `policyStoreFor` is wired) persists a matching PolicyRule so future
// equivalent requests auto-resolve. Pattern derivation:
//  - exec tools: `{ toolName, inputMatch: { command: `${firstToken}(*)` } }`
//    (first whitespace-split token of `input.command`, star-globbed).
//  - other categories: `{ toolName }` only.
// Policy persistence is a side effect — the broker.resolve call still fires
// unconditionally, so a missing `policyStoreFor` (T9 not yet wired) still
// resolves the current request.
//
// Short-alias prefix resolution: sid may be either the full sdkSessionId or
// a short alias prefix (SessionManager.getByPrefix).

import type { SessionManager } from '../session/manager.js';
import type { PermissionBroker } from '../permission/broker.js';
import type { AskUserQuestionBroker } from '../permission/ask-broker.js';
import type { ElicitationBroker } from '../permission/elicitation-broker.js';
import type { LocalSession } from '../session/local-session.js';
import type { PlatformAdapter, ReplyMarkup } from '../platform/types.js';
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ThinkingLevel,
} from '../runtime/types.js';
import type { PolicyStore } from '../permission/policy-store.js';
import type { ChannelType } from '../workspace/bindings.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import type { WorkspaceCreateBroker } from './workspace-create-broker.js';
import type { SessionPersistence } from '../session/persistence.js';
import type { Logger } from '../util/logger.js';

export interface CallbackRouterDeps {
  sessionManager: SessionManager;
  permissionBroker: PermissionBroker;
  askBroker: AskUserQuestionBroker;
  elicitationBroker: ElicitationBroker;
  /**
   * Optional adapters map for stale-card edits. T9 wires this; tests
   * pass stubs.
   */
  adapters?: Partial<Record<ChannelType, PlatformAdapter>>;
  /**
   * Optional per-workspace PolicyStore resolver. When wired, `perm:learn`
   * persists a derived PolicyRule for auto-resolution of future equivalent
   * requests. Daemon bootstrap wires a real provider; tests pass a fake.
   */
  policyStoreFor?: (workspaceId: string) => PolicyStore | Promise<PolicyStore>;
  /**
   * Optional WorkspaceManager — required for `workspace:*` callbacks
   * (Task 16). Existing tests omit it; bootstrap supplies the real instance.
   */
  workspaceManager?: WorkspaceManager;
  /**
   * Optional WorkspaceCreateBroker — required for `workspace:create:*`
   * callbacks (Task 16). Bootstrap supplies the real instance.
   */
  workspaceCreateBroker?: WorkspaceCreateBroker;
  /**
   * Optional SessionPersistence — used by `workspace:switch` to gate
   * resumeLocal on hasSnapshot probe (claude -r semantics, see spec §4.2).
   */
  persistence?: SessionPersistence;
  /**
   * Optional structured logger. When wired, callback handlers surface
   * otherwise-silent failures (interrupt/stop/save/hasSnapshot/resume/
   * adapter.send) via `logger.warn` with workspaceId/sessionId/reason
   * payload. Bootstrap supplies the daemon logger; tests pass a fake.
   */
  logger?: Logger;
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
  channelType: ChannelType;
  /**
   * Optional adapters map for direct stale-card edits. Overrides
   * `deps.adapters` when provided. Daemon wires at bootstrap.
   */
  adapters?: Map<ChannelType, PlatformAdapter>;
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
      case 'workspace':
        return this.handleWorkspace(parts, ctx);
      case 'menu':
        return this.handleMenu(parts, ctx);
      case 'turn':
        return this.handleTurn(parts, ctx);
      case 'session':
        return this.handleSession(parts, ctx);
      case 'runtime':
        return this.handleRuntime(parts, ctx);
      case 'cost':
        return this.handleCostHint(parts, ctx);
      case 'find':
        return this.handleFindHint(parts, ctx);
      default:
        return { kind: 'unknown', reason: `unknown kind: ${kind}` };
    }
  }

  // ---- Menu (Task 30) — detail-card keyboard expand/collapse -------------

  /**
   * `menu:expand` swaps the detail card's keyboard to the 12-button second
   * level; `menu:collapse` restores the default 4-button row. Text is left
   * untouched (`adapter.edit(text=undefined)` keeps the existing body).
   *
   * Missing `messageId` or adapter is treated as `unknown` — the click is
   * a no-op rather than a stale-card error since menu changes are purely
   * cosmetic (no broker state at risk).
   */
  private async handleMenu(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb] = parts;
    if (verb !== 'expand' && verb !== 'collapse') {
      return { kind: 'unknown', reason: `menu:bad-verb:${verb ?? ''}` };
    }
    if (!ctx.messageId) {
      return { kind: 'unknown', reason: 'menu:no-messageId' };
    }
    const adapter = ctx.adapters?.get(ctx.channelType) ?? this.deps.adapters?.[ctx.channelType];
    if (!adapter) return { kind: 'unknown', reason: 'menu:no-adapter' };

    const newMarkup = verb === 'expand' ? secondLevelKeyboard() : defaultLevelKeyboard();
    try {
      await adapter.edit(ctx.messageId, ctx.chatId, undefined, newMarkup);
    } catch (err) {
      this.deps.logger?.warn('menu edit failed', {
        chatId: ctx.chatId,
        messageId: ctx.messageId,
        verb,
        reason: (err as Error).message,
      });
      return { kind: 'unknown', reason: 'menu:edit-failed' };
    }
    return { kind: 'handled', action: `menu:${verb}` };
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

    // For `learn` we need the original request to derive the PolicyRule
    // pattern; snapshot it before resolve() removes it from the broker.
    let pendingReq: PermissionRequest | undefined;
    if (decision.learn) {
      pendingReq = this.deps.permissionBroker.pendingFor(sid).find((r) => r.id === reqId);
    }

    const ok = this.deps.permissionBroker.resolve(sid, reqId, decision.decision, ctx.userId);
    if (!ok) {
      // Pending not found — may have already been resolved by another operator.
      await this.editStaleCard(ctx, 'already_resolved');
      return { kind: 'stale', action: 'already_resolved' };
    }

    if (decision.learn && pendingReq) {
      await this.persistLearnedPolicy(sid, pendingReq, ctx.userId);
    }

    return {
      kind: 'handled',
      action: `perm:${verb}` + (decision.learn ? ':learn' : ''),
    };
  }

  /**
   * Persist a PolicyRule derived from `req` so future equivalent requests
   * auto-resolve. Best-effort: a missing `policyStoreFor` or a store error
   * is swallowed — the current request is already resolved as allow_always
   * by the caller, and learn is additive persistence only.
   */
  private async persistLearnedPolicy(
    sid: string,
    req: PermissionRequest,
    userId: string,
  ): Promise<void> {
    const provider = this.deps.policyStoreFor;
    if (!provider) return;
    const session = this.deps.sessionManager.get(sid);
    const workspaceId = session?.workspaceId;
    if (!workspaceId) return;
    try {
      const store = await provider(workspaceId);
      const pattern = derivePolicyPattern(req);
      await store.add(pattern, 'allow', 'workspace', userId);
    } catch {
      /* policy persistence is best-effort; don't fail the click */
    }
  }

  /**
   * Spec §13.4 — when a card is stale (session invalidated or request already
   * resolved), edit the old card in-place so the user sees the outcome. No-op
   * when adapters/messageId aren't wired; swallows adapter errors.
   */
  private async editStaleCard(
    ctx: CallbackContext,
    action: 'invalidated' | 'already_resolved',
  ): Promise<void> {
    if (!ctx.messageId) return;
    const adapter = ctx.adapters?.get(ctx.channelType) ?? this.deps.adapters?.[ctx.channelType];
    if (!adapter) return;
    const text = action === 'invalidated'
      ? 'Session invalidated — this card is no longer actionable.'
      : 'Already resolved — a newer card is above.';
    await adapter.edit(ctx.messageId, ctx.chatId, text).catch(() => undefined);
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
    if (!req) {
      await this.editStaleCard(ctx, 'already_resolved');
      return { kind: 'stale', action: 'already_resolved' };
    }
    const chosenOpt = req.options[optIdx];
    if (!chosenOpt) return { kind: 'unknown', reason: 'ask:idx-out-of-range' };
    const chosen = chosenOpt.label;

    const ok = this.deps.askBroker.resolve(sid, reqId, [chosen], ctx.userId);
    if (!ok) {
      await this.editStaleCard(ctx, 'already_resolved');
      return { kind: 'stale', action: 'already_resolved' };
    }
    return { kind: 'handled', action: 'ask:resolved' };
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

    if (!sid) return this.handleStaleSession(sidRaw, ctx);

    if (verb === 'submit') {
      const ok = this.deps.elicitationBroker.resolve(
        sid,
        reqId,
        { action: 'accept', content: {} },
        ctx.userId,
      );
      if (!ok) {
        await this.editStaleCard(ctx, 'already_resolved');
        return { kind: 'stale', action: 'already_resolved' };
      }
      return { kind: 'handled', action: 'elic:submit' };
    }
    if (verb === 'cancel') {
      const ok = this.deps.elicitationBroker.resolve(
        sid,
        reqId,
        { action: 'decline' },
        ctx.userId,
      );
      if (!ok) {
        await this.editStaleCard(ctx, 'already_resolved');
        return { kind: 'stale', action: 'already_resolved' };
      }
      return { kind: 'handled', action: 'elic:cancel' };
    }
    return { kind: 'unknown', reason: `elic:bad-verb:${verb}` };
  }

  // ---- Suggestion -------------------------------------------------------

  private async handleSuggest(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    // suggest:<sid>:<suggestionId>  OR  suggest:<sid>:<text...>
    const [sidRaw, ...rest] = parts;
    if (!sidRaw || rest.length === 0) return { kind: 'unknown', reason: 'suggest:malformed' };
    const sid = this.resolveSid(sidRaw);
    if (!sid) {
      await this.editStaleCard(ctx, 'invalidated');
      return { kind: 'stale', action: 'invalidated' };
    }
    const session = this.deps.sessionManager.get(sid);
    if (!session || session.kind !== 'local') {
      await this.editStaleCard(ctx, 'invalidated');
      return { kind: 'stale', action: 'invalidated' };
    }
    const text = rest.join(':');
    try { await (session as LocalSession).sendInput(text, 'im'); }
    catch { return { kind: 'unknown', reason: 'suggest:sendInput-failed' }; }
    return { kind: 'handled', action: 'suggest:sent' };
  }

  // ---- Queue ------------------------------------------------------------

  private async handleQueue(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    // queue:cancel:<sid>:<itemId>
    const [verb, sidRaw, ...rest] = parts;
    if (verb !== 'cancel' || !sidRaw || rest.length === 0) {
      return { kind: 'unknown', reason: 'queue:malformed' };
    }
    const itemId = rest.join(':');
    const sid = this.resolveSid(sidRaw);
    if (!sid) {
      await this.editStaleCard(ctx, 'invalidated');
      return { kind: 'stale', action: 'invalidated' };
    }
    const session = this.deps.sessionManager.get(sid);
    if (!session || session.kind !== 'local') {
      await this.editStaleCard(ctx, 'invalidated');
      return { kind: 'stale', action: 'invalidated' };
    }
    const ok = (session as LocalSession).queue.cancel(itemId);
    if (!ok) {
      await this.editStaleCard(ctx, 'already_resolved');
      return { kind: 'stale', action: 'already_resolved' };
    }
    return { kind: 'handled', action: 'queue:cancel' };
  }

  // ---- Budget -----------------------------------------------------------

  private async handleBudget(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    // budget:override:<sid>:<usd>
    const [verb, sidRaw, usdRaw] = parts;
    if (verb !== 'override' || !sidRaw || !usdRaw) {
      return { kind: 'unknown', reason: 'budget:malformed' };
    }
    const usd = Number(usdRaw);
    if (!Number.isFinite(usd) || usd <= 0) return { kind: 'unknown', reason: 'budget:bad-usd' };
    const sid = this.resolveSid(sidRaw);
    if (!sid) {
      await this.editStaleCard(ctx, 'invalidated');
      return { kind: 'stale', action: 'invalidated' };
    }
    const session = this.deps.sessionManager.get(sid);
    if (!session || session.kind !== 'local') {
      await this.editStaleCard(ctx, 'invalidated');
      return { kind: 'stale', action: 'invalidated' };
    }
    (session as unknown as { extendBudget?: (u: number) => void }).extendBudget?.(usd);
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

  // ---- Workspace (Task 16) ---------------------------------------------

  private async handleWorkspace(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, ...rest] = parts;
    if (!verb) return { kind: 'unknown', reason: 'workspace:malformed' };

    if (!this.deps.workspaceManager) return { kind: 'unknown', reason: 'workspace:no-manager' };

    switch (verb) {
      case 'bind':   return this.handleWorkspaceBind(rest, ctx);
      case 'switch': return this.handleWorkspaceSwitch(rest, ctx);
      case 'create': return this.handleWorkspaceCreate(rest, ctx);
      case 'exit':   return this.handleWorkspaceExit(rest, ctx);
      case 'config': return this.handleWorkspaceConfig(rest, ctx);
      case 'open':   return this.handleWorkspaceOpenHint(ctx);
      default:       return { kind: 'unknown', reason: `workspace:bad-verb:${verb}` };
    }
  }

  private async handleWorkspaceBind(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const wm = this.deps.workspaceManager!;
    const wsId = rest.join(':');
    if (!wsId) return { kind: 'unknown', reason: 'workspace:bind:malformed' };
    const target = wm.get(wsId);
    if (!target) {
      await this.sendReply(ctx, '❌ 工作区不存在');
      return { kind: 'unknown', reason: 'workspace:bind:not-found' };
    }
    // Single-binding-per-chat: remove existing if any.
    const existing = wm.findByChat(ctx.channelType, ctx.chatId);
    if (existing) {
      wm.removeBinding(existing.id, { channelType: ctx.channelType, chatId: ctx.chatId });
    }
    wm.addBinding(target.id, {
      channelType: ctx.channelType,
      chatId: ctx.chatId,
      role: 'primary',
    });
    await wm.save().catch((err) => {
      this.deps.logger?.warn('workspace:bind save failed', {
        wsId: target.id,
        reason: (err as Error).message,
      });
    });
    await this.sendReply(ctx, `✅ 已绑定到 "${target.name}"`);
    return { kind: 'handled', action: `workspace:bind:${target.name}` };
  }

  private async handleWorkspaceSwitch(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const wm = this.deps.workspaceManager!;
    const targetId = rest.join(':');
    if (!targetId) return { kind: 'unknown', reason: 'workspace:switch:malformed' };
    const target = wm.get(targetId);
    if (!target) {
      await this.sendReply(ctx, '❌ 目标工作区不存在');
      return { kind: 'unknown', reason: 'workspace:switch:not-found' };
    }

    // Already on this workspace — short-circuit with a distinct reply
    // rather than falling through to bind-and-reply (which would say
    // "已切到 X / 暂无活跃会话" even when the user is already on X with
    // a live session).
    const current = wm.findByChat(ctx.channelType, ctx.chatId);
    if (current?.id === target.id) {
      await this.sendReply(ctx, `已经在工作区 "${target.name}",无需切换`);
      return { kind: 'handled', action: `workspace:switch:noop:${target.name}` };
    }

    // Stop current session if any (interrupt + stop, claude -r semantics).
    // We use sessionManager.stop (not session.stop directly) so the dead
    // LocalSession is removed from the manager map — otherwise resumeLocal
    // on switch-back would short-circuit on the stopped instance instead of
    // reconstructing from the persisted snapshot.
    if (current && current.id !== target.id) {
      if (current.activeSessionId) {
        const session = this.deps.sessionManager.get(current.activeSessionId);
        if (session && session.kind === 'local') {
          try {
            await (session as LocalSession).interrupt();
          } catch (err) {
            this.deps.logger?.warn('workspace:switch interrupt failed', {
              sid: current.activeSessionId,
              reason: (err as Error).message,
            });
          }
          try {
            await this.deps.sessionManager.stop(current.activeSessionId);
          } catch (err) {
            this.deps.logger?.warn('workspace:switch stop failed', {
              sid: current.activeSessionId,
              reason: (err as Error).message,
            });
          }
        }
      }
      wm.removeBinding(current.id, { channelType: ctx.channelType, chatId: ctx.chatId });
    }
    wm.addBinding(target.id, {
      channelType: ctx.channelType,
      chatId: ctx.chatId,
      role: 'primary',
    });
    await wm.save().catch((err) => {
      this.deps.logger?.warn('workspace:switch save failed', {
        wsId: target.id,
        reason: (err as Error).message,
      });
    });

    // Try resume target's activeSession (claude -r semantics) when jsonl exists.
    const lines = [`✅ 已切到工作区 "${target.name}"`, `📂 ${target.workdir}`];
    const persistence = this.deps.persistence;
    if (target.activeSessionId && persistence) {
      let hasSnap = false;
      try {
        hasSnap = await persistence.hasSnapshot(target.activeSessionId);
      } catch (err) {
        this.deps.logger?.warn('workspace:switch hasSnapshot failed', {
          sid: target.activeSessionId,
          reason: (err as Error).message,
        });
        hasSnap = false;
      }
      if (hasSnap) {
        try {
          await this.deps.sessionManager.resumeLocal(target.activeSessionId);
          lines.push('📌 已恢复上次会话,继续对话即可');
        } catch (err) {
          const reason = (err as Error).message;
          this.deps.logger?.warn('workspace:switch resume failed', {
            sid: target.activeSessionId,
            workspaceId: target.id,
            reason,
          });
          lines.push(`⚠ 上次会话恢复失败: ${reason}`);
        }
      } else {
        lines.push('暂无活跃会话');
      }
    } else {
      lines.push('暂无活跃会话');
    }
    await this.sendReply(ctx, lines.join('\n'));
    return { kind: 'handled', action: `workspace:switch:${target.name}` };
  }

  private async handleWorkspaceCreate(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const broker = this.deps.workspaceCreateBroker;
    if (!broker) return { kind: 'unknown', reason: 'workspace:create:no-broker' };
    const [subverb] = rest;
    if (subverb === 'start') {
      broker.start({
        channelType: ctx.channelType,
        chatId: ctx.chatId,
        userId: ctx.userId,
        triggerMessageId: ctx.messageId ?? '',
      });
      const text = '📁 新增工作区\n请发送项目根目录的绝对路径\n\n例如:\n  /home/y/Project/foo\n  ~/Project/foo\n\n回 /cancel 退出';
      const markup: ReplyMarkup = {
        type: 'inline_keyboard',
        buttons: [[{ text: '❌ 取消', callbackData: 'workspace:create:cancel' }]],
      };
      await this.sendReply(ctx, text, markup);
      return { kind: 'handled', action: 'workspace:create:start' };
    }
    if (subverb === 'cancel') {
      broker.cancel(ctx.channelType, ctx.chatId);
      await this.sendReply(ctx, '已取消新增工作区');
      return { kind: 'handled', action: 'workspace:create:cancel' };
    }
    return { kind: 'unknown', reason: `workspace:create:bad-verb:${subverb ?? ''}` };
  }

  private async handleWorkspaceExit(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const wm = this.deps.workspaceManager!;
    const [subverb] = rest;
    if (subverb === 'confirm') {
      const ws = wm.findByChat(ctx.channelType, ctx.chatId);
      if (!ws) {
        await this.sendReply(ctx, '此 chat 未绑定工作区');
        return { kind: 'handled', action: 'workspace:exit:not-bound' };
      }
      const text = `确定退出工作区 "${ws.name}"?\n当前会话进程会停止,jsonl 保留;此 chat 解除绑定。`;
      const markup: ReplyMarkup = {
        type: 'inline_keyboard',
        buttons: [[
          { text: '✅ 确定', callbackData: 'workspace:exit:do' },
          { text: '❌ 取消', callbackData: 'workspace:exit:cancel' },
        ]],
      };
      await this.sendReply(ctx, text, markup);
      return { kind: 'handled', action: 'workspace:exit:confirm' };
    }
    if (subverb === 'do') {
      const ws = wm.findByChat(ctx.channelType, ctx.chatId);
      if (!ws) {
        await this.sendReply(ctx, '此 chat 未绑定');
        return { kind: 'handled', action: 'workspace:exit:not-bound' };
      }
      if (ws.activeSessionId) {
        const s = this.deps.sessionManager.get(ws.activeSessionId);
        if (s && s.kind === 'local') {
          try {
            await (s as LocalSession).stop();
          } catch (err) {
            this.deps.logger?.warn('workspace:exit stop failed', {
              sid: ws.activeSessionId,
              reason: (err as Error).message,
            });
          }
        }
      }
      wm.removeBinding(ws.id, { channelType: ctx.channelType, chatId: ctx.chatId });
      await wm.save().catch((err) => {
        this.deps.logger?.warn('workspace:exit save failed', {
          wsId: ws.id,
          reason: (err as Error).message,
        });
      });
      await this.sendReply(ctx, `✅ 已退出工作区 "${ws.name}"`);
      return { kind: 'handled', action: `workspace:exit:do:${ws.name}` };
    }
    if (subverb === 'cancel') {
      await this.sendReply(ctx, '已取消');
      return { kind: 'handled', action: 'workspace:exit:cancel' };
    }
    return { kind: 'unknown', reason: `workspace:exit:bad-verb:${subverb ?? ''}` };
  }

  private async handleWorkspaceConfig(_rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    await this.sendReply(ctx, '⚙ 工作区配置面板 — 待 Task 22 实现');
    return { kind: 'handled', action: 'workspace:config:open' };
  }

  private async handleWorkspaceOpenHint(ctx: CallbackContext): Promise<CallbackOutcome> {
    await this.sendReply(ctx, '请发 /workspace 查看/切换工作区');
    return { kind: 'handled', action: 'workspace:open:hint' };
  }

  // ---- Turn (Task 31) ---------------------------------------------------

  /**
   * `turn:stop` — interrupt the workspace's active session.
   * `turn:stop:idle` — softer reply when the detail card already showed
   *   the idle visual ('⏸' rather than '⏸ 中断'). Sent rather than silently
   *   ignored so the user gets confirmation that the click registered.
   */
  private async handleTurn(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, modifier] = parts;
    if (verb !== 'stop') return { kind: 'unknown', reason: `turn:bad-verb:${verb ?? ''}` };
    if (modifier === 'idle') {
      await this.sendReply(ctx, '当前没有进行中的对话');
      return { kind: 'handled', action: 'turn:stop:idle' };
    }
    const ws = this.deps.workspaceManager?.findByChat(ctx.channelType, ctx.chatId);
    if (!ws) {
      await this.sendReply(ctx, '此 chat 未绑定工作区');
      return { kind: 'handled', action: 'turn:stop:no-ws' };
    }
    if (!ws.activeSessionId) {
      await this.sendReply(ctx, '当前没有进行中的对话');
      return { kind: 'handled', action: 'turn:stop:no-session' };
    }
    const session = this.deps.sessionManager.get(ws.activeSessionId);
    if (!session || session.kind !== 'local') {
      await this.sendReply(ctx, '当前没有进行中的对话');
      return { kind: 'handled', action: 'turn:stop:no-live' };
    }
    try {
      await (session as LocalSession).interrupt();
    } catch (err) {
      this.deps.logger?.warn('turn:stop interrupt failed', {
        sid: ws.activeSessionId,
        reason: (err as Error).message,
      });
      await this.sendReply(ctx, `❌ 中断失败: ${(err as Error).message}`);
      return { kind: 'handled', action: 'turn:stop:failed' };
    }
    await this.sendReply(ctx, '⏸ 已中断');
    return { kind: 'handled', action: 'turn:stop' };
  }

  // ---- Session (Task 31) -----------------------------------------------

  private async handleSession(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, ...rest] = parts;
    if (!verb) return { kind: 'unknown', reason: 'session:malformed' };
    switch (verb) {
      case 'new':    return this.handleSessionNew(rest, ctx);
      case 'list':   return this.handleSessionListHint(ctx);
      case 'fork':   return this.handleSessionFork(ctx);
      case 'rename': return this.handleSessionTodo(ctx, 'rename');
      case 'export': return this.handleSessionTodo(ctx, 'export');
      case 'kill':   return this.handleSessionKill(rest, ctx);
      case 'resume': return this.handleSessionResume(rest, ctx);
      case 'details': return this.handleSessionDetails(rest, ctx);
      default:       return { kind: 'unknown', reason: `session:bad-verb:${verb}` };
    }
  }

  private async handleSessionNew(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [sub] = rest;
    const wm = this.deps.workspaceManager;
    const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
    if (sub === 'cancel') {
      await this.sendReply(ctx, '已取消');
      return { kind: 'handled', action: 'session:new:cancel' };
    }
    if (!ws) {
      await this.sendReply(ctx, '此 chat 未绑定工作区,先 /workspace 创建/绑定');
      return { kind: 'handled', action: 'session:new:no-ws' };
    }
    if (sub === 'confirm') {
      // Force-replace: stop existing then clear binding so caller can /new
      // (or send any message, which lazyResumeOrCreate will create fresh).
      if (ws.activeSessionId) {
        const s = this.deps.sessionManager.get(ws.activeSessionId);
        if (s && s.kind === 'local') {
          try { await (s as LocalSession).interrupt(); }
          catch (err) {
            this.deps.logger?.warn('session:new:confirm interrupt failed', {
              sid: ws.activeSessionId, reason: (err as Error).message,
            });
          }
          try { await (s as LocalSession).stop(); }
          catch (err) {
            this.deps.logger?.warn('session:new:confirm stop failed', {
              sid: ws.activeSessionId, reason: (err as Error).message,
            });
          }
        }
        try { wm!.clearActiveSession(ws.id); } catch { /* already cleared */ }
        await wm!.save().catch(() => undefined);
      }
      await this.sendReply(ctx, '✅ 已结束旧会话,发送一条消息开始新对话');
      return { kind: 'handled', action: 'session:new:confirm' };
    }
    // Default verb: if active session present, ask to confirm; else hint to send.
    if (ws.activeSessionId) {
      const markup: ReplyMarkup = {
        type: 'inline_keyboard',
        buttons: [[
          { text: '✅ 替换', callbackData: 'session:new:confirm' },
          { text: '❌ 取消', callbackData: 'session:new:cancel' },
        ]],
      };
      await this.sendReply(
        ctx,
        '当前已有活跃会话,继续将停止旧会话并开启新对话。确认?',
        markup,
      );
      return { kind: 'handled', action: 'session:new:prompt' };
    }
    await this.sendReply(ctx, '发送一条消息开始新对话');
    return { kind: 'handled', action: 'session:new:hint' };
  }

  private async handleSessionListHint(ctx: CallbackContext): Promise<CallbackOutcome> {
    await this.sendReply(ctx, '请发 /sessions 查看本工作区的会话列表');
    return { kind: 'handled', action: 'session:list:hint' };
  }

  private async handleSessionFork(ctx: CallbackContext): Promise<CallbackOutcome> {
    const wm = this.deps.workspaceManager;
    const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
    if (!ws) {
      await this.sendReply(ctx, '此 chat 未绑定工作区');
      return { kind: 'handled', action: 'session:fork:no-ws' };
    }
    if (!ws.activeSessionId) {
      await this.sendReply(ctx, '当前无活跃会话可 fork');
      return { kind: 'handled', action: 'session:fork:no-session' };
    }
    const s = this.deps.sessionManager.get(ws.activeSessionId);
    if (!s || s.kind !== 'local') {
      await this.sendReply(ctx, '当前无活跃会话可 fork');
      return { kind: 'handled', action: 'session:fork:no-live' };
    }
    let forkedId: string;
    try {
      const r = await (s as LocalSession).forkSession();
      forkedId = r.sdkSessionId;
    } catch (err) {
      this.deps.logger?.warn('session:fork failed', {
        sid: ws.activeSessionId, reason: (err as Error).message,
      });
      await this.sendReply(ctx, `❌ Fork 失败: ${(err as Error).message}`);
      return { kind: 'handled', action: 'session:fork:failed' };
    }
    try {
      wm!.clearActiveSession(ws.id);
      wm!.bindActiveSession(ws.id, forkedId);
      await wm!.save().catch(() => undefined);
    } catch (err) {
      this.deps.logger?.warn('session:fork bindActive failed', {
        wsId: ws.id, sid: forkedId, reason: (err as Error).message,
      });
    }
    await this.sendReply(ctx, `🍴 已 fork: ${shortAlias(forkedId)}`);
    return { kind: 'handled', action: `session:fork:${shortAlias(forkedId)}` };
  }

  private async handleSessionTodo(ctx: CallbackContext, verb: string): Promise<CallbackOutcome> {
    await this.sendReply(ctx, `(TODO) ${verb} 功能尚未实现`);
    return { kind: 'handled', action: `session:${verb}:todo` };
  }

  private async handleSessionKill(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [sub] = rest;
    const wm = this.deps.workspaceManager;
    const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
    if (sub === 'cancel') {
      await this.sendReply(ctx, '已取消');
      return { kind: 'handled', action: 'session:kill:cancel' };
    }
    if (!ws) {
      await this.sendReply(ctx, '此 chat 未绑定工作区');
      return { kind: 'handled', action: 'session:kill:no-ws' };
    }
    if (sub === 'confirm') {
      if (!ws.activeSessionId) {
        await this.sendReply(ctx, '当前无活跃会话');
        return { kind: 'handled', action: 'session:kill:no-session' };
      }
      const markup: ReplyMarkup = {
        type: 'inline_keyboard',
        buttons: [[
          { text: '✅ 杀死', callbackData: 'session:kill:do' },
          { text: '❌ 取消', callbackData: 'session:kill:cancel' },
        ]],
      };
      await this.sendReply(
        ctx,
        `确定杀死当前会话 (${shortAlias(ws.activeSessionId)})?\n进程会停止,jsonl 保留。`,
        markup,
      );
      return { kind: 'handled', action: 'session:kill:prompt' };
    }
    if (sub === 'do') {
      if (!ws.activeSessionId) {
        await this.sendReply(ctx, '当前无活跃会话');
        return { kind: 'handled', action: 'session:kill:no-session' };
      }
      const sid = ws.activeSessionId;
      const s = this.deps.sessionManager.get(sid);
      if (s && s.kind === 'local') {
        try { await (s as LocalSession).stop(); }
        catch (err) {
          this.deps.logger?.warn('session:kill stop failed', {
            sid, reason: (err as Error).message,
          });
        }
      }
      try { wm!.clearActiveSession(ws.id); } catch { /* already cleared */ }
      await wm!.save().catch(() => undefined);
      await this.sendReply(ctx, `☠ 已杀死会话 ${shortAlias(sid)}`);
      return { kind: 'handled', action: 'session:kill:do' };
    }
    return { kind: 'unknown', reason: `session:kill:bad-verb:${sub ?? ''}` };
  }

  private async handleSessionResume(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const sidRaw = rest.join(':');
    if (!sidRaw) return { kind: 'unknown', reason: 'session:resume:malformed' };
    const sid = this.resolveSid(sidRaw) ?? sidRaw;
    let resumed: LocalSession | null = null;
    try { resumed = await this.deps.sessionManager.resumeLocal(sid); }
    catch (err) {
      this.deps.logger?.warn('session:resume failed', {
        sid, reason: (err as Error).message,
      });
      await this.sendReply(ctx, `❌ 恢复失败: ${(err as Error).message}`);
      return { kind: 'handled', action: 'session:resume:failed' };
    }
    if (!resumed) {
      await this.sendReply(ctx, '❌ 找不到该会话或无法恢复');
      return { kind: 'handled', action: 'session:resume:not-found' };
    }
    const wm = this.deps.workspaceManager;
    const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
    if (ws && wm) {
      try {
        if (ws.activeSessionId && ws.activeSessionId !== resumed.id) {
          wm.clearActiveSession(ws.id);
        }
        if (ws.activeSessionId !== resumed.id) {
          wm.bindActiveSession(ws.id, resumed.id);
        }
        await wm.save().catch(() => undefined);
      } catch (err) {
        this.deps.logger?.warn('session:resume bindActive failed', {
          wsId: ws.id, sid: resumed.id, reason: (err as Error).message,
        });
      }
    }
    await this.sendReply(ctx, `📌 已恢复会话 ${shortAlias(resumed.id)}`);
    return { kind: 'handled', action: `session:resume:${shortAlias(resumed.id)}` };
  }

  private async handleSessionDetails(_rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    await this.sendReply(ctx, '(TODO) details 功能尚未实现 — 请发 /sessions');
    return { kind: 'handled', action: 'session:details:todo' };
  }

  // ---- Runtime (Task 31) -----------------------------------------------

  private async handleRuntime(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [domain, ...rest] = parts;
    if (!domain) return { kind: 'unknown', reason: 'runtime:malformed' };
    switch (domain) {
      case 'model':  return this.handleRuntimeModel(rest, ctx);
      case 'mode':   return this.handleRuntimeMode(rest, ctx);
      case 'think':  return this.handleRuntimeThink(rest, ctx);
      case 'budget': return this.handleRuntimeBudget(rest, ctx);
      case 'perm':   return this.handleRuntimePerm(rest, ctx);
      default:       return { kind: 'unknown', reason: `runtime:bad-domain:${domain}` };
    }
  }

  private async handleRuntimeModel(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, ...idParts] = rest;
    if (verb === 'open') {
      await this.sendReply(ctx, '请发 /model 查看模型选择');
      return { kind: 'handled', action: 'runtime:model:open' };
    }
    if (verb === 'custom') {
      await this.sendReply(ctx, '请发 /model <id> 切换到自定义模型');
      return { kind: 'handled', action: 'runtime:model:custom' };
    }
    if (verb === 'set-default') {
      await this.sendReply(ctx, '当前模型已是 workspace 默认 (TODO: 显式确认)');
      return { kind: 'handled', action: 'runtime:model:set-default' };
    }
    if (verb === 'set') {
      const wm = this.deps.workspaceManager;
      const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
      if (!ws) {
        await this.sendReply(ctx, '此 chat 未绑定工作区');
        return { kind: 'handled', action: 'runtime:model:set:no-ws' };
      }
      const id = idParts.join(':');
      if (!id) return { kind: 'unknown', reason: 'runtime:model:set:no-id' };
      if (ws.activeSessionId) {
        const s = this.deps.sessionManager.get(ws.activeSessionId);
        if (s && s.kind === 'local') {
          try { await (s as LocalSession).setModel(id); }
          catch (err) {
            this.deps.logger?.warn('runtime:model set failed', {
              sid: ws.activeSessionId, reason: (err as Error).message,
            });
            await this.sendReply(ctx, `❌ 切换失败: ${(err as Error).message}`);
            return { kind: 'handled', action: 'runtime:model:set:failed' };
          }
        }
      }
      ws.defaults.model = id;
      await wm!.save().catch(() => undefined);
      await this.sendReply(ctx, `✅ 模型已切到 ${id}`);
      return { kind: 'handled', action: `runtime:model:set:${id}` };
    }
    return { kind: 'unknown', reason: `runtime:model:bad-verb:${verb ?? ''}` };
  }

  private async handleRuntimeMode(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, ...modeParts] = rest;
    if (verb === 'open') {
      await this.sendReply(ctx, '请发 /mode 查看权限模式选择');
      return { kind: 'handled', action: 'runtime:mode:open' };
    }
    if (verb !== 'set') return { kind: 'unknown', reason: `runtime:mode:bad-verb:${verb ?? ''}` };
    const wm = this.deps.workspaceManager;
    const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
    if (!ws) {
      await this.sendReply(ctx, '此 chat 未绑定工作区');
      return { kind: 'handled', action: 'runtime:mode:set:no-ws' };
    }
    const mode = modeParts.join(':') as PermissionMode;
    if (!isValidPermissionMode(mode)) {
      return { kind: 'unknown', reason: `runtime:mode:bad-value:${mode}` };
    }
    if (ws.activeSessionId) {
      const s = this.deps.sessionManager.get(ws.activeSessionId);
      if (s && s.kind === 'local') {
        try { await (s as LocalSession).setPermissionMode(mode); }
        catch (err) {
          this.deps.logger?.warn('runtime:mode set failed', {
            sid: ws.activeSessionId, reason: (err as Error).message,
          });
          await this.sendReply(ctx, `❌ 切换失败: ${(err as Error).message}`);
          return { kind: 'handled', action: 'runtime:mode:set:failed' };
        }
      }
    }
    ws.defaults.permissionMode = mode;
    await wm!.save().catch(() => undefined);
    await this.sendReply(ctx, `✅ 权限模式已切到 ${mode}`);
    return { kind: 'handled', action: `runtime:mode:set:${mode}` };
  }

  private async handleRuntimeThink(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, levelRaw] = rest;
    if (verb === 'open') {
      await this.sendReply(ctx, '请发 /think 查看 thinking 选项');
      return { kind: 'handled', action: 'runtime:think:open' };
    }
    if (verb !== 'set') return { kind: 'unknown', reason: `runtime:think:bad-verb:${verb ?? ''}` };
    const wm = this.deps.workspaceManager;
    const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
    if (!ws) {
      await this.sendReply(ctx, '此 chat 未绑定工作区');
      return { kind: 'handled', action: 'runtime:think:set:no-ws' };
    }
    const level = levelRaw as ThinkingLevel;
    if (!isValidThinkingLevel(level)) {
      return { kind: 'unknown', reason: `runtime:think:bad-value:${level}` };
    }
    ws.defaults.thinking = level;
    await wm!.save().catch(() => undefined);
    await this.sendReply(ctx, `✅ thinking 已切到 ${level}`);
    return { kind: 'handled', action: `runtime:think:set:${level}` };
  }

  private async handleRuntimeBudget(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, valueRaw] = rest;
    if (verb === 'open') {
      await this.sendReply(ctx, '请发 /budget 查看预算选项');
      return { kind: 'handled', action: 'runtime:budget:open' };
    }
    if (verb === 'custom') {
      await this.sendReply(ctx, '请发 /budget <usd> 设置自定义预算');
      return { kind: 'handled', action: 'runtime:budget:custom' };
    }
    if (verb !== 'set') return { kind: 'unknown', reason: `runtime:budget:bad-verb:${verb ?? ''}` };
    const wm = this.deps.workspaceManager;
    const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
    if (!ws) {
      await this.sendReply(ctx, '此 chat 未绑定工作区');
      return { kind: 'handled', action: 'runtime:budget:set:no-ws' };
    }
    if (!ws.activeSessionId) {
      await this.sendReply(ctx, '当前无活跃会话');
      return { kind: 'handled', action: 'runtime:budget:set:no-session' };
    }
    const s = this.deps.sessionManager.get(ws.activeSessionId);
    if (!s || s.kind !== 'local') {
      await this.sendReply(ctx, '当前无活跃会话');
      return { kind: 'handled', action: 'runtime:budget:set:no-live' };
    }
    let cap: number | undefined;
    if (valueRaw === 'unlimited') {
      cap = undefined;
    } else {
      const usd = Number(valueRaw);
      if (!Number.isFinite(usd) || usd <= 0) {
        return { kind: 'unknown', reason: `runtime:budget:bad-value:${valueRaw ?? ''}` };
      }
      cap = usd;
    }
    (s as LocalSession).setMaxBudget(cap);
    const display = cap === undefined ? '无上限' : `$${cap.toFixed(2)}`;
    await this.sendReply(ctx, `💸 预算已设为 ${display}`);
    return {
      kind: 'handled',
      action: `runtime:budget:set:${cap === undefined ? 'unlimited' : cap}`,
    };
  }

  private async handleRuntimePerm(rest: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb, sub] = rest;
    if (verb === 'open') {
      await this.sendReply(ctx, '请发 /perm 查看权限规则');
      return { kind: 'handled', action: 'runtime:perm:open' };
    }
    if (verb === 'add') {
      if (sub === 'allow') {
        await this.sendReply(ctx, '请发 /perm allow <pattern> 添加 allow 规则');
        return { kind: 'handled', action: 'runtime:perm:add:allow' };
      }
      if (sub === 'deny') {
        await this.sendReply(ctx, '请发 /perm deny <pattern> 添加 deny 规则');
        return { kind: 'handled', action: 'runtime:perm:add:deny' };
      }
      return { kind: 'unknown', reason: `runtime:perm:add:bad-verb:${sub ?? ''}` };
    }
    if (verb === 'clear') {
      if (sub === 'cancel') {
        await this.sendReply(ctx, '已取消');
        return { kind: 'handled', action: 'runtime:perm:clear:cancel' };
      }
      if (sub === 'confirm') {
        const markup: ReplyMarkup = {
          type: 'inline_keyboard',
          buttons: [[
            { text: '✅ 清空', callbackData: 'runtime:perm:clear:do' },
            { text: '❌ 取消', callbackData: 'runtime:perm:clear:cancel' },
          ]],
        };
        await this.sendReply(ctx, '确定清空本工作区所有权限规则?', markup);
        return { kind: 'handled', action: 'runtime:perm:clear:prompt' };
      }
      if (sub === 'do') {
        const wm = this.deps.workspaceManager;
        const ws = wm?.findByChat(ctx.channelType, ctx.chatId);
        if (!ws) {
          await this.sendReply(ctx, '此 chat 未绑定工作区');
          return { kind: 'handled', action: 'runtime:perm:clear:no-ws' };
        }
        const provider = this.deps.policyStoreFor;
        if (!provider) {
          await this.sendReply(ctx, '(TODO) PolicyStore 未配置');
          return { kind: 'handled', action: 'runtime:perm:clear:no-store' };
        }
        try {
          const store = await provider(ws.id);
          const rules = store.list();
          for (const r of rules) await store.remove(r.id);
          await this.sendReply(ctx, `✅ 已清空 ${rules.length} 条规则`);
          return { kind: 'handled', action: `runtime:perm:clear:do:${rules.length}` };
        } catch (err) {
          this.deps.logger?.warn('runtime:perm:clear failed', {
            wsId: ws.id, reason: (err as Error).message,
          });
          await this.sendReply(ctx, `❌ 清空失败: ${(err as Error).message}`);
          return { kind: 'handled', action: 'runtime:perm:clear:failed' };
        }
      }
      return { kind: 'unknown', reason: `runtime:perm:clear:bad-verb:${sub ?? ''}` };
    }
    return { kind: 'unknown', reason: `runtime:perm:bad-verb:${verb ?? ''}` };
  }

  // ---- Cost / Find / Workspace-open (hint-only) ------------------------

  private async handleCostHint(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb] = parts;
    if (verb !== 'open') return { kind: 'unknown', reason: `cost:bad-verb:${verb ?? ''}` };
    await this.sendReply(ctx, '请发 /cost 查看成本仪表盘');
    return { kind: 'handled', action: 'cost:open' };
  }

  private async handleFindHint(parts: string[], ctx: CallbackContext): Promise<CallbackOutcome> {
    const [verb] = parts;
    if (verb !== 'prompt') return { kind: 'unknown', reason: `find:bad-verb:${verb ?? ''}` };
    await this.sendReply(ctx, '请发 /find <关键词> 搜索 jsonl');
    return { kind: 'handled', action: 'find:prompt' };
  }

  /** Send a fresh reply via the resolved adapter. No-op when adapter unavailable. */
  private async sendReply(ctx: CallbackContext, text: string, replyMarkup?: ReplyMarkup): Promise<void> {
    const adapter = ctx.adapters?.get(ctx.channelType) ?? this.deps.adapters?.[ctx.channelType];
    if (!adapter) return;
    await adapter.send({ chatId: ctx.chatId, text, replyMarkup }).catch((err) => {
      this.deps.logger?.warn('callback sendReply failed', {
        chatId: ctx.chatId,
        channelType: ctx.channelType,
        reason: (err as Error).message,
      });
    });
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
   * card is invalidated. On `invalidated` we also edit the old card via
   * adapters so the user sees the outcome even without a subsequent broker
   * event. On `resumed_waiting` the renderer will eventually replace the
   * card once the pending request re-issues.
   */
  private async handleStaleSession(sidRaw: string, ctx: CallbackContext): Promise<CallbackOutcome> {
    if (!sidRaw) {
      await this.editStaleCard(ctx, 'invalidated');
      return { kind: 'stale', action: 'invalidated' };
    }
    const resumed = await this.deps.sessionManager.resumeLocal(sidRaw).catch(() => null);
    if (resumed) return { kind: 'stale', action: 'resumed_waiting' };
    await this.editStaleCard(ctx, 'invalidated');
    return { kind: 'stale', action: 'invalidated' };
  }
}

/**
 * Derive a PolicyRule pattern from a PermissionRequest for `perm:learn`.
 * Exec tools get the leading command token globbed (e.g. `npm(*)`) so
 * future `npm install`, `npm test`, etc. auto-resolve. Everything else
 * falls back to toolName-only.
 */
function derivePolicyPattern(
  req: PermissionRequest,
): { toolName?: string; inputMatch?: Record<string, unknown> } {
  if (req.category === 'exec') {
    const input = (req.toolInput ?? {}) as { command?: unknown };
    const cmd = typeof input.command === 'string' ? input.command : '';
    const firstToken = cmd.split(/\s+/).filter((s) => s.length > 0)[0];
    if (firstToken) {
      return { toolName: req.toolName, inputMatch: { command: `${firstToken}(*)` } };
    }
  }
  return { toolName: req.toolName };
}

/**
 * Default 4-button keyboard for the detail card. Mirrors
 * `defaultDetailKeyboard` in format-telegram.ts (kept in two places so the
 * renderer doesn't import from callback-router).
 */
function defaultLevelKeyboard(): ReplyMarkup {
  return {
    type: 'inline_keyboard',
    buttons: [[
      { text: '🆕 new', callbackData: 'session:new' },
      { text: '📋 list', callbackData: 'session:list' },
      { text: '⏸ 中断', callbackData: 'turn:stop' },
      { text: '⋯', callbackData: 'menu:expand' },
    ]],
  };
}

/**
 * Second-level 12-button + collapse-row keyboard surfaced via
 * `menu:expand` (spec §10.1). Every callback is namespaced so the router
 * can dispatch to the right subsystem.
 */
function secondLevelKeyboard(): ReplyMarkup {
  return {
    type: 'inline_keyboard',
    buttons: [
      [
        { text: '🔄 model', callbackData: 'runtime:model:open' },
        { text: '🎚 mode', callbackData: 'runtime:mode:open' },
        { text: '🧠 think', callbackData: 'runtime:think:open' },
        { text: '💰 cost', callbackData: 'cost:open' },
      ],
      [
        { text: '✨ perm', callbackData: 'runtime:perm:open' },
        { text: '💸 budget', callbackData: 'runtime:budget:open' },
        { text: '📁 切ws', callbackData: 'workspace:open' },
        { text: '🔍 find', callbackData: 'find:prompt' },
      ],
      [
        { text: '🍴 fork', callbackData: 'session:fork' },
        { text: '📝 rename', callbackData: 'session:rename' },
        { text: '☠ kill', callbackData: 'session:kill:confirm' },
        { text: '📤 export', callbackData: 'session:export' },
      ],
      [{ text: '↩ 关闭菜单', callbackData: 'menu:collapse' }],
    ],
  };
}

/** Last 7 hex chars of a session id — render-friendly alias. */
function shortAlias(sid: string): string {
  return sid.length > 7 ? sid.slice(-7) : sid;
}

const VALID_PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  'default', 'yolo', 'safe-yolo', 'plan',
  'acceptEdits', 'dontAsk', 'bypassPermissions',
];
function isValidPermissionMode(m: string): m is PermissionMode {
  return (VALID_PERMISSION_MODES as ReadonlyArray<string>).includes(m);
}

const VALID_THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = ['collapsed', 'expanded', 'hidden'];
function isValidThinkingLevel(l: string): l is ThinkingLevel {
  return (VALID_THINKING_LEVELS as ReadonlyArray<string>).includes(l);
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
