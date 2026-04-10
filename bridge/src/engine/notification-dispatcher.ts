// bridge/src/engine/notification-dispatcher.ts
//
// Dispatches notifications from terminal sessions to IM adapters.
// Extracted from terminal-relay.ts.

import type { BaseChannelAdapter } from '../channels/base.js';
import type { ChannelType } from '../channels/types.js';
import type { NotificationRenderer, NotificationEvent as RendererNotificationEvent } from '../renderers/types.js';
import { TargetResolver } from './target-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  text: string;
  buttons?: Array<{ label: string; callbackData: string; style?: string }>;
  sessionId?: string;
  workdir?: string;
  /** Structured notification event from terminal (v1.0 IPC upgrade). */
  event?: Record<string, unknown>;
}

export interface DispatchResult {
  channelType: string;
  messageId: string;
}

// ---------------------------------------------------------------------------
// NotificationDispatcher
// ---------------------------------------------------------------------------

export class NotificationDispatcher {
  /** Called after a notification is successfully sent — provides messageId for tracking. */
  onSent: ((result: DispatchResult) => void) | null = null;

  constructor(
    private getAdapters: () => BaseChannelAdapter[],
    private targetResolver: TargetResolver,
    private renderers: Map<ChannelType, NotificationRenderer>,
    private log: (msg: string) => void,
    private warn: (msg: string) => void,
  ) {}

  /**
   * Dispatch a notification to all configured IM adapters.
   * Returns a map of channelType -> messageId for successfully sent messages.
   */
  async dispatch(notification: NotificationPayload): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (const adapter of this.getAdapters()) {
      const target = this.targetResolver.resolve(adapter.channelType);
      if (!target) continue;

      const renderer = this.renderers.get(adapter.channelType as ChannelType);

      try {
        let result;
        if (notification.event && renderer) {
          // Structured event → Renderer
          const rendered = renderer.renderNotification(notification.event as RendererNotificationEvent);
          result = await adapter.send(target.chatId, rendered);
        } else if (renderer) {
          // Fallback: plain text via renderer
          result = await adapter.send(target.chatId, renderer.renderSimpleText(notification.text));
        } else {
          // Should not happen — all channels have renderers now
          this.warn(`No renderer for ${adapter.channelType}, skipping notification`);
          continue;
        }

        const msgId = result?.messageId;
        if (msgId) {
          results.set(adapter.channelType, msgId);
          this.onSent?.({ channelType: adapter.channelType, messageId: msgId });
        }
      } catch (err) {
        this.warn(`-> ${adapter.channelType}: ${err}`);
      }
    }

    return results;
  }
}
