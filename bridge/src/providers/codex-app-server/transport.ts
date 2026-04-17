import type { ChildProcess } from 'node:child_process';

/**
 * stdio byte stream ↔ JSONL message stream.
 *
 * ASSUMPTION: codex-app-server serializes via serde_json, which escapes all
 * control characters inside JSON strings. A raw 0x0A byte therefore only
 * appears as a line terminator, never inside a value. If that assumption
 * ever breaks (e.g., codex adopts pretty-printing), this split() logic must
 * change to a proper JSON stream parser.
 */
export class StdioJsonlTransport {
  private buffer = '';
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private messageHandlers: Array<(m: unknown) => void> = [];
  private errorHandlers: Array<(e: Error) => void> = [];
  private exitHandlers: Array<(e: { code: number | null; signal: string | null }) => void> = [];
  private closed = false;

  constructor(private child: ChildProcess) {
    if (!child.stdout || !child.stdin) {
      throw new Error('StdioJsonlTransport: child process must have stdout + stdin');
    }
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stdout.on('error', (err: Error) => this.errorHandlers.forEach(h => h(err)));
    child.on('exit', (code, signal) => {
      this.exitHandlers.forEach(h => h({ code, signal }));
    });
  }

  onMessage(cb: (m: unknown) => void): void {
    this.messageHandlers.push(cb);
  }

  onError(cb: (e: Error) => void): void {
    this.errorHandlers.push(cb);
  }

  onExit(cb: (e: { code: number | null; signal: string | null }) => void): void {
    this.exitHandlers.push(cb);
  }

  sendMessage(msg: unknown): void {
    if (this.closed) return;
    this.child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  async close(timeoutMs = 5000): Promise<{ code: number | null; signal: string | null }> {
    this.closed = true;
    return new Promise((resolve) => {
      let resolved = false;
      const done = (e: { code: number | null; signal: string | null }) => {
        if (resolved) return;
        resolved = true;
        resolve(e);
      };
      this.onExit(done);
      // Close stdin to signal EOF
      try { this.child.stdin?.end(); } catch { /* ignore */ }
      // Escalation timers
      const termTimer = setTimeout(() => {
        if (resolved) return;
        try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
      }, timeoutMs);
      const killTimer = setTimeout(() => {
        if (resolved) return;
        try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeoutMs + 1000);
      // Clean timers when resolved
      this.onExit(() => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
      });
    });
  }

  private onData(chunk: Buffer): void {
    // Decoder preserves incomplete UTF-8 sequences across chunks
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line);
        this.messageHandlers.forEach(h => h(msg));
      } catch (err) {
        this.errorHandlers.forEach(h => h(err as Error));
      }
    }
  }
}
