import { randomUUID } from 'node:crypto';

export const RETRY_PROMPT = 'Retry the last request that failed due to an API error. Continue from the current state; do not repeat completed work.';
const DELAYS = [5, 15, 30];
export interface RetryConfig { enabled?: boolean; maxAttempts?: number }
export type RetryOutcome = 'sent' | 'stale' | 'unavailable' | 'failed';
interface RetryState {
  id: string; key: string; attempts: number; chats: Set<string>; expectedPrompt: boolean; condition: string;
  timer?: ReturnType<typeof setTimeout>; expiry?: ReturnType<typeof setTimeout>;
}
export interface RetryView { id: string; attempts: number; maxAttempts: number; canRetry: boolean; newAction: boolean; nextDelaySec?: number }

/** Recovery only uses the existing wrapped-session input path. Each action is
 * bound to a session and configured chat, and is consumed before any I/O. */
export class SessionRetry {
  private states = new Map<string, RetryState>();
  private ids = new Map<string, string>();
  private stopped = false;
  private maxAttempts: number;
  constructor(private config: RetryConfig, private deps: {
    canRetry: (key: string) => boolean;
    inject: (key: string, text: string) => Promise<void>;
    notify: (key: string, outcome: Exclude<RetryOutcome, 'stale'>, attempts: number) => void;
  }) {
    const n = config.maxAttempts;
    this.maxAttempts = typeof n === 'number' && Number.isFinite(n) ? Math.min(3, Math.max(0, Math.floor(n))) : 3;
  }

  failure(key: string, retryable: boolean, chats: Array<{channel: string; chatId: string}>, condition = ''): RetryView {
    const previous = this.states.get(key);
    const attempts = previous?.attempts ?? 0;
    const reuse = previous?.condition === condition && this.ids.get(previous.id) === key;
    this.clear(key);
    const id = reuse ? previous!.id : randomUUID();
    const canRetry = !this.stopped && this.deps.canRetry(key);
    const state: RetryState = { id, key, attempts, chats: new Set(chats.map(c => `${c.channel}:${c.chatId}`)), expectedPrompt: false, condition };
    if (!this.stopped) {
      this.states.set(key, state); this.ids.set(id, key);
      state.expiry = setTimeout(() => {
        this.ids.delete(state.id);
        if (state.timer) clearTimeout(state.timer);
      }, 30 * 60_000);
      state.expiry.unref();
    }
    const nextDelaySec = this.config.enabled === true && retryable && canRetry && attempts < this.maxAttempts ? DELAYS[attempts] : undefined;
    if (nextDelaySec !== undefined) {
      state.timer = setTimeout(() => { void this.execute(state, true); }, nextDelaySec * 1000);
      state.timer.unref();
    }
    return { id, attempts, maxAttempts: this.maxAttempts, canRetry, newAction: !reuse, ...(nextDelaySec !== undefined ? {nextDelaySec} : {}) };
  }

  /** A newly arrived failure cancels any queued retry before notification grace. */
  noteFailure(key: string, condition: string): void {
    const s = this.states.get(key);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    if (s.condition !== condition) this.ids.delete(s.id);
  }

  async answer(id: string, channel: string, chatId: string): Promise<RetryOutcome> {
    const key = this.ids.get(id);
    const s = key ? this.states.get(key) : undefined;
    if (!s || !s.chats.has(`${channel}:${chatId}`)) return 'stale';
    return this.execute(s, false);
  }

  private async execute(s: RetryState, automatic: boolean): Promise<RetryOutcome> {
    if (this.stopped || this.ids.get(s.id) !== s.key || this.states.get(s.key) !== s) return 'stale';
    this.ids.delete(s.id);
    if (s.timer) clearTimeout(s.timer);
    if (!this.deps.canRetry(s.key)) {
      if (automatic) this.deps.notify(s.key, 'unavailable', s.attempts);
      return 'unavailable';
    }
    if (automatic) s.attempts++;
    s.expectedPrompt = true;
    try {
      await this.deps.inject(s.key, RETRY_PROMPT);
      if (automatic && this.states.get(s.key) === s && !this.stopped) this.deps.notify(s.key, 'sent', s.attempts);
      return 'sent';
    } catch {
      s.expectedPrompt = false;
      if (automatic && this.states.get(s.key) === s && !this.stopped) this.deps.notify(s.key, 'failed', s.attempts);
      return 'failed';
    }
  }

  prompt(key: string, text: string): void {
    const s = this.states.get(key);
    if (s?.expectedPrompt && text.trim() === RETRY_PROMPT) { s.expectedPrompt = false; return; }
    // A new user turn invalidates the old action, but only a successful Stop
    // resets the retry budget. Repeated failing prompts cannot re-arm it forever.
    if (s) { this.ids.delete(s.id); if (s.timer) clearTimeout(s.timer); s.expectedPrompt = false; }
  }
  complete(key: string): void { this.clear(key); }
  private clear(key: string): void {
    const s = this.states.get(key);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    if (s.expiry) clearTimeout(s.expiry);
    this.ids.delete(s.id); this.states.delete(key);
  }
  stop(): void { this.stopped = true; for (const key of this.states.keys()) this.clear(key); }
}
