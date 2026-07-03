//
// Foreground owner of a wrapped pty. Mirrors to the local terminal (stdout always
// when attachLocal; stdin raw only on a TTY) AND serves pty bytes over a per-session
// unix socket using the stream-protocol. Multiple clients share one screen;
// pty size = last-input authority (the source that most recently typed owns the grid);
// the authoritative size is broadcast to every socket client as a Size frame.

import { spawn, type IPty } from 'node-pty';
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { isPipePath } from '../ipc/client.js';
import { FrameDecoder, FrameType, encodeData, encodeSize, parseDims } from '../web/stream-protocol.js';

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

export interface SizeSource { cols: number; rows: number; lastInputSeq: number; isLocal?: boolean }

/** Last-input authority: the source that most recently sent input owns the pty grid.
 *  Ties (nobody has typed yet) prefer the local TTY, else the first known size. */
export function authoritativeSize(sources: SizeSource[]): { cols: number; rows: number } {
  const valid = sources.filter((s) => s.cols > 0 && s.rows > 0);
  if (valid.length === 0) return { cols: 80, rows: 24 };
  let best = valid[0];
  for (const s of valid) {
    if (s.lastInputSeq > best.lastInputSeq) best = s;
    else if (s.lastInputSeq === best.lastInputSeq && s.isLocal && !best.isLocal) best = s;
  }
  const clamp = (n: number): number => Math.max(1, Math.min(1000, Math.floor(n)));
  return { cols: clamp(best.cols), rows: clamp(best.rows) };
}

interface Client extends SizeSource { socket: Socket; attached?: boolean }

export class SessionHost {
  private pty: IPty | null = null;
  private server: Server | null = null;
  private clients = new Set<Client>();
  private localTty: SizeSource | null = null;
  private inputSeq = 0;
  private appliedSize: { cols: number; rows: number } | null = null;
  private attachLocal: boolean;
  private onExitCb: ((code: number) => void) | null = null;
  private cleanedUp = false;
  // Shadow screen: a headless xterm fed with every pty byte, serialized on
  // Attach so late joiners get the CURRENT screen instead of a blank page.
  private shadow: HeadlessTerminal | null = null;
  private serializer: SerializeAddon | null = null;

  constructor(private opts: SessionHostOpts) {
    this.attachLocal = opts.attachLocal !== false;
  }

  async start(): Promise<void> {
    if (this.attachLocal && process.stdout.isTTY) {
      this.localTty = { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24, lastInputSeq: ++this.inputSeq, isLocal: true };
    }
    const size = this.currentSize();
    this.pty = spawn(this.opts.cmd, this.opts.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: this.opts.cwd,
      // TLIVE_SESSION marks "you are inside a tlive-wrapped pty" (like $TMUX):
      // lets scripts detect the wrapper and lets `tlive run` refuse to nest.
      env: { ...(this.opts.env ?? process.env), TLIVE_SESSION: this.opts.id } as Record<string, string>,
    });

    this.shadow = new HeadlessTerminal({ cols: size.cols, rows: size.rows, scrollback: 1000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.shadow.loadAddon(this.serializer);

    this.pty.onData((data: string) => {
      // node-pty onData yields a decoded string; utf8 round-trips terminal content.
      // For raw-binary passthrough we'd spawn with encoding:null (deferred).
      const buf = Buffer.from(data, 'utf8');
      if (this.attachLocal) process.stdout.write(buf);
      this.shadow?.write(data);
      const frame = encodeData(buf);
      for (const c of this.clients) { if (c.attached && c.socket.writable) c.socket.write(frame); }
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

    // Windows named pipes aren't filesystem entries — exists/unlink/chmod don't apply.
    const isPipe = isPipePath(this.opts.sockPath);
    if (!isPipe && existsSync(this.opts.sockPath)) unlinkSync(this.opts.sockPath);
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
    if (!isPipe) { try { chmodSync(this.opts.sockPath, 0o600); } catch { /* best-effort perms */ } }
  }

  onExit(cb: (code: number) => void): void { this.onExitCb = cb; }

  async stop(): Promise<void> {
    this.cleanup();
    try { this.pty?.kill(); } catch { /* already dead */ }
  }

  private onLocalInput = (chunk: Buffer): void => {
    if (this.localTty) { this.localTty.lastInputSeq = ++this.inputSeq; this.applySize(); }
    this.pty?.write(chunk.toString('utf8'));
  };

  private onLocalResize = (): void => {
    if (process.stdout.isTTY && this.localTty) {
      this.localTty.cols = process.stdout.columns ?? 80;
      this.localTty.rows = process.stdout.rows ?? 24;
      this.applySize();
    }
  };

  private onClient(socket: Socket): void {
    socket.on('error', () => { /* ignore broken pipe */ });
    const client: Client = { socket, cols: 0, rows: 0, lastInputSeq: 0 };
    this.clients.add(client);
    const dec = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const f of dec.push(chunk)) {
        if (f.type === FrameType.Data) {
          client.lastInputSeq = ++this.inputSeq;
          this.applySize();
          this.pty?.write(f.payload.toString('utf8'));
        } else if (f.type === FrameType.Attach || f.type === FrameType.Resize) {
          const { cols, rows } = parseDims(f.payload);
          client.cols = cols; client.rows = rows;
          const firstAttach = f.type === FrameType.Attach && !client.attached;
          client.attached = true;
          const applied = this.applySize();
          // Late-joiner guarantee: if the broadcast didn't fire (size unchanged), tell this client directly.
          if (!applied.broadcast && socket.writable) socket.write(encodeSize(applied.cols, applied.rows));
          // Screen rebuild: Size first (grid set), then the serialized current screen.
          if (firstAttach && socket.writable && this.serializer) {
            try {
              const snap = this.serializer.serialize();
              if (snap.length > 0) socket.write(encodeData(Buffer.from(snap, 'utf8')));
            } catch { /* serialize is best-effort; live output follows anyway */ }
          }
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
    const sources: SizeSource[] = [];
    if (this.localTty) sources.push(this.localTty);
    for (const c of this.clients) sources.push(c);
    return authoritativeSize(sources);
  }

  private applySize(): { cols: number; rows: number; broadcast: boolean } {
    const next = this.currentSize();
    if (this.appliedSize && this.appliedSize.cols === next.cols && this.appliedSize.rows === next.rows) {
      return { cols: next.cols, rows: next.rows, broadcast: false };
    }
    this.appliedSize = next;
    try { this.pty?.resize(next.cols, next.rows); } catch { /* pty gone */ }
    try { this.shadow?.resize(next.cols, next.rows); } catch { /* headless quirk */ }
    const frame = encodeSize(next.cols, next.rows);
    for (const c of this.clients) { if (c.attached && c.socket.writable) c.socket.write(frame); }
    return { cols: next.cols, rows: next.rows, broadcast: true };
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
    try { this.shadow?.dispose(); } catch { /* ignore */ }
    this.shadow = null; this.serializer = null;
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } this.server = null; }
    if (!isPipePath(this.opts.sockPath) && existsSync(this.opts.sockPath)) { try { unlinkSync(this.opts.sockPath); } catch { /* ignore */ } }
  }
}
