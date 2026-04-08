// src/im/sessionRouter.ts

export interface RouteResult {
  kind: 'sdk_session' | 'terminal_takeover' | 'new_session';
  sessionId?: string;
  workdir?: string;
}

export interface TerminalNotification {
  messageId: string;
  sessionId: string;
  workdir: string;
}

export class SessionRouter {
  private groupBindings = new Map<string, { sessionId: string; workdir: string }>();
  private privateBindings = new Map<string, { sessionId: string; workdir: string }>();
  private terminalNotifications = new Map<string, TerminalNotification>();
  private workdirMemory = new Map<string, string>();

  bindGroup(chatId: string, sessionId: string, workdir: string): void {
    this.groupBindings.set(chatId, { sessionId, workdir });
  }
  unbindGroup(chatId: string): void {
    this.groupBindings.delete(chatId);
  }

  bindPrivate(chatId: string, sessionId: string, workdir: string): void {
    this.privateBindings.set(chatId, { sessionId, workdir });
    this.workdirMemory.set(chatId, workdir);
  }
  unbindPrivate(chatId: string): void {
    this.privateBindings.delete(chatId);
  }

  registerTerminalNotification(messageId: string, sessionId: string, workdir: string): void {
    this.terminalNotifications.set(messageId, { messageId, sessionId, workdir });
  }

  getLastWorkdir(chatId: string): string | undefined {
    return this.workdirMemory.get(chatId);
  }

  route(opts: {
    chatId: string;
    isGroup: boolean;
    callbackSessionId?: string;
    replyToMessageId?: string;
  }): RouteResult {
    const { chatId, isGroup, callbackSessionId, replyToMessageId } = opts;

    // 1. Button callback with explicit sessionId
    if (callbackSessionId) return { kind: 'sdk_session', sessionId: callbackSessionId };

    // 2. Group → bound session
    if (isGroup) {
      const binding = this.groupBindings.get(chatId);
      if (binding) return { kind: 'sdk_session', sessionId: binding.sessionId, workdir: binding.workdir };
      return { kind: 'new_session' };
    }

    // 3. Private + reply to terminal notification → takeover
    if (replyToMessageId) {
      const notif = this.terminalNotifications.get(replyToMessageId);
      if (notif) return { kind: 'terminal_takeover', sessionId: notif.sessionId, workdir: notif.workdir };
    }

    // 4. Private + existing session
    const priv = this.privateBindings.get(chatId);
    if (priv) return { kind: 'sdk_session', sessionId: priv.sessionId, workdir: priv.workdir };

    // 5. New session
    return { kind: 'new_session', workdir: this.workdirMemory.get(chatId) };
  }

  pruneTerminalNotifications(): void {
    if (this.terminalNotifications.size > 1000) {
      const entries = [...this.terminalNotifications.entries()];
      for (const [key] of entries.slice(0, entries.length - 500)) {
        this.terminalNotifications.delete(key);
      }
    }
  }
}
