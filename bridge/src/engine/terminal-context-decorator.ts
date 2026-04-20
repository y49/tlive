// bridge/src/engine/terminal-context-decorator.ts
//
// Middleware: enrich a NotificationEvent with session-context-derived display
// fields (workspace tag title, terminalUrl, resumeHint) before the renderer runs.
// Called from NotificationDispatcher for scanner-path notifications; bridge-path
// notifications (SDK engine) don't set sessionCtx so the decorator is bypassed
// via the `isScannerPathNotification` guard.

import type { NotificationEvent } from '../renderers/types.js';
import type { ScannerContextSnapshot, NotificationPayload } from './notification-dispatcher.js';

/**
 * Type guard: returns true for scanner-path notifications that want context decoration.
 * Bridge-path notifications (SDK engine) don't set sessionCtx and bypass the decorator.
 * Narrows the type so callers get `sessionCtx: ScannerContextSnapshot` (non-optional).
 */
export function isScannerPathNotification(
  n: NotificationPayload,
): n is NotificationPayload & { sessionCtx: ScannerContextSnapshot } {
  return n.sessionCtx !== undefined && n.sessionCtx.isLocal === true;
}

/**
 * Pure. Enrich an event with workspace tag, terminalUrl, and resumeHint derived
 * from the scanner session context. Preserves any fields already set on the event
 * (decorator never overwrites an explicit value).
 *
 * Per-kind behavior:
 *  - activity_text: default title = "Terminal · <workspace> · #<6char> · local"; default terminalUrl = ctx.terminalUrl.
 *  - activity_tool: default terminalUrl = ctx.terminalUrl.
 *  - session_complete: default resumeHint = "Reply here ... or run `<provider> resume <sessionId>` in a terminal."; default terminalUrl.
 *  - all other kinds: passthrough.
 */
export function decorateEvent(
  event: NotificationEvent,
  ctx: ScannerContextSnapshot,
): NotificationEvent {
  const shortId = ctx.sessionId.slice(0, 6);
  const workspaceTag = `Terminal · ${ctx.workspaceName} · #${shortId} · local`;

  switch (event.kind) {
    case 'activity_text':
      return {
        ...event,
        title: event.title ?? workspaceTag,
        terminalUrl: event.terminalUrl ?? ctx.terminalUrl,
      };
    case 'activity_tool':
      return { ...event, terminalUrl: event.terminalUrl ?? ctx.terminalUrl };
    case 'session_complete':
      return {
        ...event,
        resumeHint: event.resumeHint
          ?? `Reply here to continue in IM, or run \`${ctx.provider} resume ${ctx.sessionId}\` in a terminal.`,
        terminalUrl: event.terminalUrl ?? ctx.terminalUrl,
      };
    case 'ask_user_question':
    case 'permission_request':
    case 'thinking':
    case 'reasoning_summary':
    case 'todo_update':
    case 'file_change_list':
    case 'error':
      return event;
  }
}
