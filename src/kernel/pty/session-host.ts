//
// Foreground owner of a wrapped pty. Mirrors to the local terminal (stdout always
// when attachLocal; stdin raw only on a TTY) AND serves pty bytes over a per-session
// unix socket using the stream-protocol. Multiple clients share one screen; pty size
// = min-of-attached (local TTY + every attached socket client).

import { spawn, type IPty } from 'node-pty';
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { FrameDecoder, FrameType, encodeData, parseDims } from '../web/stream-protocol.js';

export interface SessionHostOpts {
  id: string;
  cmd: string;
  args: string[];
  cwd: string;
  sockPath: string;
  env?: NodeJS.ProcessEnv;
  /** Mirror to / read from the local terminal. Default true; tests pass false. */
  attachLocal?: boolean;
}

interface Client {
  socket: Socket;
  cols: number; // 0 until the client sends attach/resize
  rows: number;
}

export function computeSize(dims: Array<{ cols: number; rows: number }>): { cols: number; rows: number } {
  if (dims.length === 0) return { cols: 80, rows: 24 };
  return {
    cols: Math.max(1, Math.min(...dims.map((d) => d.cols))),
    rows: Math.max(1, Math.min(...dims.map((d) => d.rows))),
  };
}

export class SessionHost {
  private pty: IPty | null = null;
  private server: Server | null = null;
  private clients = new Set<Client>();
  private localTty: { cols: number; rows: number } | null = null;
  private attachLocal: boolean;
  private onExitCb: ((code: number) => void) | null = null;
  private cleanedUp = false;

  constructor(private opts: SessionHostOpts) {
    this.attachLocal = opts.attachLocal !== false;
  }

  async start(): Promise<void> {
    if (this.attachLocal && process.stdout.isTTY) {
      this.localTty = { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
    }
    const size = this.currentSize();
    this.pty = spawn(this.opts.cmd, this.opts.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: this.opts.cwd,
      env: { ...(this.opts.env ?? process.env) } as Record<string, string>,
    });

    this.pty.onData((data: string) => {
      // node-pty onData yields a decoded string; utf8 round-trips terminal content.
      // For raw-binary passthrough we'd spawn with encoding:null (deferred).
      const buf = Buffer.from(data, 'utf8');
      if (this.attachLocal) process.stdout.write(buf);
      const frame = encodeData(buf);
      for (const c of this.clients) { if (c.socket.writable) c.socket.write(frame); }
    });

    this.pty.onExit(({ exitCode }) => {
      this.cleanup();
      this.onExitCb?.(exitCode);
    });

    if (this.attachLocal && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', this.onLocalInput);
    }
    if (this.attachLocal && process.stdout.isTTY) {
      process.stdout.on('resize', this.onLocalResize);
    }

    if (existsSync(this.opts.sockPath)) unlinkSync(this.opts.sockPath);
    this.server = createServer((socket) => this.onClient(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(this.opts.sockPath, () => resolve());
      });
    } catch (e) {
      this.cleanup();
      throw e;
    }
    try { chmodSync(this.opts.sockPath, 0o600); } catch { /* best-effort perms */ }
  }

  onExit(cb: (code: number) => void): void { this.onExitCb = cb; }

  async stop(): Promise<void> {
    this.cleanup();
    try { this.pty?.kill(); } catch { /* already dead */ }
  }

  private onLocalInput = (chunk: Buffer): void => {
    this.pty?.write(chunk.toString('utf8'));
  };

  private onLocalResize = (): void => {
    if (process.stdout.isTTY) {
      this.localTty = { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
      this.applySize();
    }
  };

  private onClient(socket: Socket): void {
    socket.on('error', () => { /* ignore broken pipe */ });
    const client: Client = { socket, cols: 0, rows: 0 };
    this.clients.add(client);
    const dec = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const f of dec.push(chunk)) {
        if (f.type === FrameType.Data) {
          this.pty?.write(f.payload.toString('utf8'));
        } else if (f.type === FrameType.Attach || f.type === FrameType.Resize) {
          const { cols, rows } = parseDims(f.payload);
          client.cols = cols; client.rows = rows;
          this.applySize();
        } else if (f.type === FrameType.Detach) {
          this.removeClient(client);
        }
      }
    });
    socket.on('close', () => this.removeClient(client));
  }

  private removeClient(client: Client): void {
    if (this.clients.delete(client)) this.applySize();
  }

  private currentSize(): { cols: number; rows: number } {
    const dims: Array<{ cols: number; rows: number }> = [];
    if (this.localTty) dims.push(this.localTty);
    for (const c of this.clients) if (c.cols > 0 && c.rows > 0) dims.push({ cols: c.cols, rows: c.rows });
    return computeSize(dims);
  }

  private applySize(): void {
    const { cols, rows } = this.currentSize();
    try { this.pty?.resize(cols, rows); } catch { /* pty gone */ }
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.attachLocal && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* not a tty anymore */ }
      process.stdin.off('data', this.onLocalInput);
      process.stdin.pause();
    }
    if (this.attachLocal && process.stdout.isTTY) {
      process.stdout.off('resize', this.onLocalResize);
    }
    for (const c of this.clients) { try { c.socket.destroy(); } catch { /* ignore */ } }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } this.server = null; }
    if (existsSync(this.opts.sockPath)) { try { unlinkSync(this.opts.sockPath); } catch { /* ignore */ } }
  }
}
