export type StatusPhase =
  | { kind: 'thinking' }
  | { kind: 'reading'; target: string }
  | { kind: 'editing'; target: string }
  | { kind: 'running'; target: string }
  | { kind: 'awaiting_permission' }
  | { kind: 'done'; durationMs?: number; costUsd?: number }
  | { kind: 'error'; message: string };

export interface StatusPayload {
  phase: StatusPhase['kind'];
  target?: string;
  durationMs?: number;
  costUsd?: number;
  message?: string;
}

export interface SessionStatusLineOptions {
  send: (payload: StatusPayload) => Promise<string>;
  edit: (messageId: string, payload: StatusPayload) => Promise<boolean>;
  throttleMs: number;
}

export class SessionStatusLine {
  private messageId: string | null = null;
  private pendingPayload: StatusPayload | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(private opts: SessionStatusLineOptions) {}

  async setPhase(phase: StatusPhase): Promise<void> {
    const payload = SessionStatusLine.toPayload(phase);
    this.pendingPayload = payload;
    if (this.timer) return; // already scheduled
    this.timer = setTimeout(() => { void this.flush(); }, this.opts.throttleMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing) return;
    const payload = this.pendingPayload;
    if (!payload) return;
    this.pendingPayload = null;
    this.flushing = true;
    try {
      if (this.messageId) {
        const ok = await this.opts.edit(this.messageId, payload);
        if (!ok) {
          // fall back: send new message, track id
          this.messageId = await this.opts.send(payload);
        }
      } else {
        this.messageId = await this.opts.send(payload);
      }
    } finally {
      this.flushing = false;
    }
  }

  private static toPayload(phase: StatusPhase): StatusPayload {
    switch (phase.kind) {
      case 'reading':
      case 'editing':
      case 'running':
        return { phase: phase.kind, target: phase.target };
      case 'done':
        return { phase: 'done', durationMs: phase.durationMs, costUsd: phase.costUsd };
      case 'error':
        return { phase: 'error', message: phase.message };
      default:
        return { phase: phase.kind };
    }
  }
}
