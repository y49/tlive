// bridge/src/engine/reply-interceptor.ts
//
// Tracks outbound notification message IDs and intercepts inbound IM replies
// that target those messages, forwarding them back to the terminal via IPC.
// Extracted from terminal-relay.ts.

// ---------------------------------------------------------------------------
// ReplyInterceptor
// ---------------------------------------------------------------------------

export class ReplyInterceptor {
  private trackedMsgIds = new Set<string>();

  /** Callback invoked when a reply should be forwarded to the terminal. */
  onForward: ((msg: Record<string, unknown>) => void) | null = null;

  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  /** Track a message ID so replies to it can be intercepted. */
  trackMessage(messageId: string): void {
    this.trackedMsgIds.add(messageId);
    this.log(`Tracked notification: ${messageId}`);
  }

  /**
   * Check if an inbound IM message is a reply to a tracked notification.
   * Returns true if consumed (forwarded to terminal via onForward callback).
   */
  interceptReply(msg: { text: string; replyToMessageId?: string }): boolean {
    this.log(`interceptReply: replyTo=${msg.replyToMessageId ?? 'NONE'}, tracked=${this.trackedMsgIds.size}, match=${msg.replyToMessageId ? this.trackedMsgIds.has(msg.replyToMessageId) : false}`);
    if (!msg.replyToMessageId || !this.trackedMsgIds.has(msg.replyToMessageId)) {
      return false;
    }
    this.log(`Forwarding reply to terminal: "${msg.text.slice(0, 50)}"`);
    this.onForward?.({ type: 'terminal_input', payload: { text: msg.text } });
    return true;
  }

  /**
   * Handle a callback from IM that targets a terminal session question.
   * Returns true if consumed.
   */
  handleAskCallback(callbackData: string): boolean {
    if (!callbackData.startsWith('askq:')) return false;
    const parts = callbackData.split(':');
    const toolUseId = parts[1];
    const selection = parts[2]; // index number or 'skip'

    const answer = selection === 'skip' ? '' : selection;
    const optionIndex = selection === 'skip' ? -1 : parseInt(selection, 10);

    this.onForward?.({
      type: 'question_answer',
      payload: { toolUseId, answer, optionIndex },
    });
    return true;
  }
}
