// bridge/src/engine/session-frontend.ts
//
// Full renderer path between daemon-level SessionManager and IM channels.
// Subscribes to SessionManager + PermissionBroker events, looks up the target
// chat via WorkspaceManager + channel adapters, renders via NotificationRenderer,
// and sends via adapter. One subscription per live session, torn down on
// 'stopped' to prevent leaks.

import type { SessionManager } from '../../../src/session/manager.js';
import type { PermissionBroker as RuntimePermissionBroker } from '../../../src/session/permission-broker.js';
import type { PermissionRequest } from '../../../src/runtime/types.js';
import type { NotificationRenderer, NotificationEvent } from '../renderers/types.js';
import type { ChannelType } from '../channels/types.js';
import type { Session } from '../../../src/session/session.js';
import type { WorkspaceManager } from './workspace-manager.js';
import type { BaseChannelAdapter } from '../channels/base.js';

export interface SessionFrontendDeps {
  sessionManager: SessionManager;
  permissionBroker: RuntimePermissionBroker;
  workspaceManager: WorkspaceManager;
  renderers: Map<ChannelType, NotificationRenderer>;
  getAdapters: () => Map<string, BaseChannelAdapter>;
}

export class SessionFrontend {
  private readonly sessionUnsubs = new Map<string, () => void>();
  private managerUnsub: (() => void) | null = null;
  private brokerUnsub: (() => void) | null = null;

  constructor(private readonly deps: SessionFrontendDeps) {}

  start(): void {
    this.managerUnsub = this.deps.sessionManager.subscribe((ev) => {
      if (ev.kind === 'created' || ev.kind === 'resumed') this.attach(ev.session);
      else if (ev.kind === 'stopped') this.detach(ev.sessionId);
    });
    this.brokerUnsub = this.deps.permissionBroker.subscribe((ev) => {
      if (ev.kind === 'pending') void this.renderPermission(ev.sessionId, ev.request);
    });
  }

  stop(): void {
    this.managerUnsub?.();
    this.managerUnsub = null;
    this.brokerUnsub?.();
    this.brokerUnsub = null;
    for (const un of this.sessionUnsubs.values()) un();
    this.sessionUnsubs.clear();
  }

  private attach(session: Session): void {
    // Guard against a 'resumed' event firing after 'created' for the same id.
    // Detach the old listener so we don't accumulate duplicates.
    const existing = this.sessionUnsubs.get(session.id);
    if (existing) existing();
    const unsub = session.subscribe((ev) => {
      if (ev.kind === 'event') void this.renderEvent(session.id, ev.event);
    });
    this.sessionUnsubs.set(session.id, unsub);
  }

  private detach(sessionId: string): void {
    const unsub = this.sessionUnsubs.get(sessionId);
    if (unsub) {
      unsub();
      this.sessionUnsubs.delete(sessionId);
    }
  }

  private async renderEvent(sessionId: string, event: NotificationEvent): Promise<void> {
    const target = this.resolveChannel(sessionId);
    if (!target) return;
    const renderer = this.deps.renderers.get(target.channelType);
    if (!renderer) return;
    const message = renderer.renderNotification(event);
    if (!message) return;
    const adapter = this.deps.getAdapters().get(target.channelType);
    if (!adapter) return;
    await adapter.send(target.chatId, message).catch(() => { /* transient adapter errors */ });
  }

  private async renderPermission(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    const notification: NotificationEvent = {
      kind: 'permission_request',
      toolName: request.toolName,
      toolInput: JSON.stringify(request.toolInput),
      permissionId: request.id,
    };
    await this.renderEvent(sessionId, notification);
  }

  /**
   * Pick the target (channelType, chatId) to render a session event to.
   * Workspace → chatId is the canonical binding; the adapter map decides
   * which channelType owns that chatId. Falls back to the first adapter if
   * no adapter claims ownership via a `canAddress` duck-typed method.
   *
   * Limitation: when multiple channels are enabled and the workspace was
   * bound via a different channel, we may broadcast to the wrong one. This
   * is acceptable for Phase 2 — Phase 3 may refine by storing `channelType`
   * on the workspace record.
   */
  private resolveChannel(sessionId: string): { channelType: ChannelType; chatId: string } | null {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return null;
    const workspace =
      this.deps.workspaceManager.findByName(session.context.workspaceId) ??
      this.deps.workspaceManager.getDefault();
    if (!workspace?.chatId) return null;
    const adapters = this.deps.getAdapters();
    for (const [key, adapter] of adapters) {
      const canAddr = (adapter as unknown as { canAddress?: (id: string) => boolean }).canAddress;
      if (typeof canAddr === 'function' && canAddr.call(adapter, workspace.chatId)) {
        return { channelType: key as ChannelType, chatId: workspace.chatId };
      }
    }
    // Fallback: no adapter claims ownership — broadcast to first adapter.
    const firstKey = adapters.keys().next().value as ChannelType | undefined;
    return firstKey ? { channelType: firstKey, chatId: workspace.chatId } : null;
  }
}
