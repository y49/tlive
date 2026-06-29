// src/kernel/permission/continue-broker.ts
//
// Stop-hook 续跑撮合:hook 阻塞等用户在 IM 回复,回复文本作为续跑指令;
// 超时返回 null(= 正常停止)。仿 ask-broker 的 requestId 模式。

import { randomUUID } from 'node:crypto';

export interface ContinueRequest {
  requestId: string;
  cwd: string;
  context: string;
}

export class ContinueBroker {
  private pending = new Map<string, (r: string | null) => void>();
  private handler?: (req: ContinueRequest) => void;

  onRequest(h: (req: ContinueRequest) => void): void {
    this.handler = h;
  }

  request(opts: { cwd: string; context: string; timeoutSec: number }): Promise<string | null> {
    const requestId = randomUUID();
    return new Promise<string | null>((resolve) => {
      this.pending.set(requestId, resolve);
      this.handler?.({ requestId, cwd: opts.cwd, context: opts.context });
      setTimeout(() => {
        const r = this.pending.get(requestId);
        if (r) { this.pending.delete(requestId); r(null); }
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
