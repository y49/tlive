// src/session/remote-session.ts
//
// RemoteSession — the Companion-mode counterpart to LocalSession. The daemon
// does NOT own a runtime here: state flows inbound from MCP tool calls the
// external agent makes against tlive-self (`tlive.sync.state`, `tlive.approve`,
// `tlive.ask.remote`, etc., wired in T5). This class synthesizes
// NotificationEvents from those calls so the IM frontend renders remote
// sessions identically to local ones.
//
// Scope (T3): expose public mutators (`setStatus`, `addPendingPermission`,
// `addPendingAsk`, `addPendingElicitation`, `recordAttachment`,
// `onDisconnect`). T5 wires the MCP server to invoke them.

import type {
  AgentProvider, AskUserQuestionRequest, ElicitationRequest, PermissionRequest,
} from '../runtime/types.js';
import type { NotificationEvent } from '../runtime/events.js';
import { SessionContext } from './context.js';
import { CostTracker } from '../cost/tracker.js';
import type { AgentStatus } from './status.js';
import type { SessionInfo, SessionLike } from './types.js';
import { shortId } from '../util/short-id.js';

export interface RemoteSessionInit {
  sdkSessionId: string;
  workspaceId: string;
  workdir: string;
  provider: AgentProvider;
  title?: string;
}

export interface RemoteStatusDetail {
  currentTool?: string;
  /** Epoch ms at which the remote entered this phase — defaulted to now(). */
  at?: number;
  /** Free-form reason text surfaced by /sync.state. */
  reason?: string;
}

/**
 * RemoteSession. Identified in UI by the `r-` prefix on shortAlias so
 * operators can distinguish MCP-driven remotes from daemon-owned locals.
 */
export class RemoteSession implements SessionLike {
  readonly kind = 'remote' as const;
  readonly id: string;
  readonly shortAlias: string;
  readonly provider: AgentProvider;
  readonly workspaceId: string;
  readonly workdir: string;
  readonly ctx: SessionContext;
  title: string | undefined;
  readonly cost = new CostTracker();

  private agentStatus: AgentStatus = { phase: 'initializing' };
  private readonly createdAt: number;
  private lastActivityAt: number;
  private _isReady = true;
  private disconnected = false;

  private readonly eventListeners = new Set<(e: NotificationEvent) => void>();
  private readonly statusListeners = new Set<(s: AgentStatus) => void>();
  private readonly pendingPermissions = new Map<string, PermissionRequest>();
  private readonly pendingAsks = new Map<string, AskUserQuestionRequest>();
  private readonly pendingElicitations = new Map<string, ElicitationRequest>();

  constructor(init: RemoteSessionInit) {
    this.id = init.sdkSessionId;
    this.shortAlias = `r-${shortId(init.sdkSessionId)}`;
    this.provider = init.provider;
    this.workspaceId = init.workspaceId;
    this.workdir = init.workdir;
    this.title = init.title;
    this.ctx = SessionContext.create({
      sessionId: init.sdkSessionId,
      workdir: init.workdir,
      workspaceId: init.workspaceId,
      provider: init.provider,
    });
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
  }

  // ---- SessionLike surface --------------------------------------------------

  /** v0.x bridge shim — returns the SessionContextSnapshot directly. */
  get context() { return this.ctx.snapshot; }

  /**
   * Shim for legacy callers (bridge IPC) that handle `send_input`. Remote
   * sessions can't accept daemon-side input — the external agent drives the
   * conversation via its own SDK. This throws so routing bugs are loud.
   */
  async sendInput(_text: string, _source?: 'im' | 'cli'): Promise<void> {
    throw new Error(`RemoteSession(${this.id}): sendInput is not supported — remote agent drives its own input`);
  }

  get status(): AgentStatus { return this.agentStatus; }
  set status(next: AgentStatus) {
    this.agentStatus = next;
    this.emitStatus(next);
  }
  get isReady(): boolean { return this._isReady; }
  // RemoteSession does not surface SDK init metadata (no local runtime).
  // Remote daemon owns the system event; cross-IPC propagation deferred.
  readonly sdkModel: string | undefined = undefined;
  readonly sdkMaxContextTokens: number | undefined = undefined;

  onEvent(cb: (e: NotificationEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }
  onStatusChange(cb: (s: AgentStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
  onSessionIdReady(cb: (id: string) => void): () => void {
    // Remote sessions are born with the id known; fire synchronously.
    try { cb(this.id); } catch { /* isolate */ }
    return () => undefined;
  }

  snapshot(): SessionInfo {
    const c = this.cost.snapshot();
    return {
      id: this.id,
      shortAlias: this.shortAlias,
      kind: 'remote',
      provider: this.provider,
      workspaceId: this.workspaceId,
      workdir: this.workdir,
      title: this.title,
      status: this.agentStatus,
      cost: {
        totalCost: c.costUsd,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens ?? 0,
        cacheCreationTokens: c.cacheCreationTokens ?? 0,
      },
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  // ---- MCP-driven mutators (spec §4.3) --------------------------------------

  /**
   * Primary status shim for `tlive.sync.state(phase, detail?)`. Recomputes
   * the full AgentStatus from the MCP-reported phase + detail so renderers
   * can treat remote and local sessions uniformly.
   */
  // TODO(T5): append RollupDelta to CostRollupStore when MCP sync.state carries cost_delta.
  setStatus(phase: AgentStatus['phase'], detail?: RemoteStatusDetail): void {
    if (this.disconnected) return;
    this.touch();
    const at = detail?.at ?? Date.now();
    let next: AgentStatus;
    switch (phase) {
      case 'initializing': next = { phase: 'initializing' }; break;
      case 'idle':         next = { phase: 'idle', queuedInputs: 0 }; break;
      case 'thinking':
        next = { phase: 'thinking', turnStartedAt: at, currentTool: detail?.currentTool, queuedInputs: 0, subagents: 0 };
        break;
      case 'awaiting_permission':
        next = { phase: 'awaiting_permission', requestId: detail?.reason ?? 'unknown', queuedInputs: 0 };
        break;
      case 'awaiting_question':
        next = { phase: 'awaiting_question', requestId: detail?.reason ?? 'unknown' };
        break;
      case 'awaiting_elicitation':
        next = { phase: 'awaiting_elicitation', requestId: detail?.reason ?? 'unknown' };
        break;
      case 'interrupted': next = { phase: 'interrupted', at, reason: detail?.reason }; break;
      case 'handed_off':  next = { phase: 'handed_off', at }; break;
      case 'errored':
        next = { phase: 'errored', code: 'remote_error', message: detail?.reason ?? 'remote session reported error' };
        break;
      case 'stopped':     next = { phase: 'stopped' }; break;
      default: next = { phase: 'initializing' };
    }
    this.agentStatus = next;
    this.emitStatus(next);
    this.emitEvent({ kind: 'status_change', status: next });
  }

  /** Called from `tlive.approve(...)` MCP handler — exposes request to IM. */
  addPendingPermission(req: PermissionRequest): void {
    if (this.disconnected) return;
    this.touch();
    this.pendingPermissions.set(req.id, req);
    this.emitEvent({
      kind: 'permission_requested',
      requestId: req.id,
      category: req.category,
      toolName: req.toolName,
      toolInput: req.toolInput,
    });
  }

  resolvePendingPermission(id: string, decision: 'allow' | 'deny' | 'allow_always'): boolean {
    const req = this.pendingPermissions.get(id);
    if (!req) return false;
    this.pendingPermissions.delete(id);
    req.resolve(decision);
    this.emitEvent({ kind: 'permission_resolved', requestId: id, decision });
    return true;
  }

  addPendingAsk(req: AskUserQuestionRequest): void {
    if (this.disconnected) return;
    this.touch();
    this.pendingAsks.set(req.id, req);
    this.emitEvent({
      kind: 'ask_user_question_requested',
      requestId: req.id,
      prompt: req.prompt,
      options: req.options.map((o) => o.label),
    });
  }

  resolvePendingAsk(id: string, chosen: string[]): boolean {
    const req = this.pendingAsks.get(id);
    if (!req) return false;
    this.pendingAsks.delete(id);
    req.resolve(chosen);
    this.emitEvent({ kind: 'ask_user_question_resolved', requestId: id, chosen });
    return true;
  }

  addPendingElicitation(req: ElicitationRequest): void {
    if (this.disconnected) return;
    this.touch();
    this.pendingElicitations.set(req.id, req);
    this.emitEvent({
      kind: 'elicitation_requested',
      requestId: req.id,
      mcpServerName: req.mcpServerName,
      description: req.description,
      schema: req.schema,
    });
  }

  resolvePendingElicitation(
    id: string,
    result: { action: 'accept' | 'decline'; content?: Record<string, unknown> },
  ): boolean {
    const req = this.pendingElicitations.get(id);
    if (!req) return false;
    this.pendingElicitations.delete(id);
    req.resolve(result);
    this.emitEvent({
      kind: 'elicitation_resolved',
      requestId: id,
      action: result.action,
      content: result.content,
    });
    return true;
  }

  /** Record an attachment produced by the remote agent (t/l.artifact.upload). */
  recordAttachment(att: { attachmentId: string; name: string; mime: string; sizeBytes: number; path: string }): void {
    if (this.disconnected) return;
    this.touch();
    this.emitEvent({
      kind: 'attachment_produced',
      attachmentId: att.attachmentId,
      name: att.name,
      mime: att.mime,
      sizeBytes: att.sizeBytes,
      path: att.path,
    });
  }

  /** MCP transport closed — remote is gone. Terminal. */
  onDisconnect(reason?: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this._isReady = false;
    // Reject every still-pending request so MCP callers unblock.
    for (const req of this.pendingPermissions.values()) {
      try { req.resolve('deny'); } catch { /* isolate */ }
    }
    for (const req of this.pendingAsks.values()) {
      try { req.resolve([]); } catch { /* isolate */ }
    }
    for (const req of this.pendingElicitations.values()) {
      try { req.resolve({ action: 'decline' }); } catch { /* isolate */ }
    }
    this.pendingPermissions.clear();
    this.pendingAsks.clear();
    this.pendingElicitations.clear();
    this.agentStatus = { phase: 'stopped' };
    this.emitStatus(this.agentStatus);
    this.emitEvent({
      kind: 'session_complete',
      reason: reason ?? 'remote_disconnect',
      summary: reason ?? 'Remote MCP session disconnected',
    });
  }

  listPendingPermissions(): PermissionRequest[] {
    return [...this.pendingPermissions.values()];
  }

  listPendingAsks(): AskUserQuestionRequest[] {
    return [...this.pendingAsks.values()];
  }

  listPendingElicitations(): ElicitationRequest[] {
    return [...this.pendingElicitations.values()];
  }

  // ---- Internal ------------------------------------------------------------

  private emitEvent(e: NotificationEvent): void {
    for (const l of this.eventListeners) { try { l(e); } catch { /* isolate */ } }
  }
  private emitStatus(s: AgentStatus): void {
    for (const l of this.statusListeners) { try { l(s); } catch { /* isolate */ } }
  }
  private touch(): void { this.lastActivityAt = Date.now(); }
}
