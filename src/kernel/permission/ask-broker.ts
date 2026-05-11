// src/kernel/permission/ask-broker.ts

import { randomUUID } from 'node:crypto';

export interface AskRequest {
  requestId: string;
  pid: number;
  question: string;
}

export class AskBroker {
  private pending = new Map<string, (s: string) => void>();
  private requestHandler?: (req: AskRequest) => void;

  onRequest(handler: (req: AskRequest) => void): void {
    this.requestHandler = handler;
  }

  async ask(opts: { pid: number; question: string; timeoutSec: number }): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve) => {
      this.pending.set(requestId, resolve);
      this.requestHandler?.({ requestId, pid: opts.pid, question: opts.question });
      setTimeout(() => {
        const r = this.pending.get(requestId);
        if (r) { this.pending.delete(requestId); r('(timeout)'); }
      }, opts.timeoutSec * 1000).unref();
    });
  }

  answer(requestId: string, reply: string): void {
    const r = this.pending.get(requestId);
    if (!r) return;
    this.pending.delete(requestId);
    r(reply);
  }
}
