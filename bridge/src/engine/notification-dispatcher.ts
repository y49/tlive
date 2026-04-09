// bridge/src/engine/notification-dispatcher.ts
//
// Dispatches notifications from terminal sessions to IM adapters.
// Extracted from terminal-relay.ts.

import type { BaseChannelAdapter } from '../channels/base.js';
import { TargetResolver, type ResolvedTarget } from './target-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  text: string;
  buttons?: Array<{ label: string; callbackData: string; style?: string }>;
  sessionId?: string;
  workdir?: string;
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
    private log: (msg: string) => void,
    private warn: (msg: string) => void,
  ) {}

  /**
   * Dispatch a notification to all configured IM adapters.
   * Returns a map of channelType -> messageId for successfully sent messages.
   */
  async dispatch(notification: NotificationPayload): Promise<Map<string, string>> {
    const { text, buttons } = notification;
    const results = new Map<string, string>();

    for (const adapter of this.getAdapters()) {
      const target = this.targetResolver.resolve(adapter.channelType);
      if (!target) continue;

      // Determine card header style based on notification content
      const isPermission = text.includes('Permission');
      const isQuestion = text.includes('Question');
      const isDone = text.includes('Done');
      const isThinking = text.includes('Thinking');
      const feishuHeader = adapter.channelType === 'feishu' ? {
        template: isPermission ? 'orange' : isQuestion ? 'blue' : isDone ? 'green' : isThinking ? 'grey' : 'turquoise',
        title: isPermission ? 'Permission Request' : isQuestion ? 'Question' : isDone ? 'Done' : isThinking ? 'Thinking...' : 'Terminal',
      } : undefined;

      try {
        const result = await adapter.send({
          chatId: target.chatId,
          receiveIdType: target.receiveIdType,
          text,
          buttons: buttons?.map((b) => ({
            label: b.label,
            callbackData: b.callbackData,
            style: b.style as 'primary' | 'danger' | undefined,
          })),
          feishuHeader,
        } as any);

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
