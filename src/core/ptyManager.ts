import { spawn as ptySpawn, type IPty } from 'node-pty';
import { EventEmitter } from 'node:events';

export interface PTYOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export class PTYManager extends EventEmitter {
  private pty: IPty | null = null;
  private _exitCode: number | null = null;

  get isRunning(): boolean {
    return this.pty !== null;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get pid(): number | undefined {
    return this.pty?.pid;
  }

  spawn(opts: PTYOptions): void {
    if (this.pty) throw new Error('PTY already running');

    const env = {
      ...process.env,
      ...opts.env,
      TERM: process.env.TERM ?? 'xterm-256color',
    };

    this.pty = ptySpawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? process.stdout.columns ?? 80,
      rows: opts.rows ?? process.stdout.rows ?? 24,
      cwd: opts.cwd,
      env,
    });

    this.pty.onData((data) => this.emit('data', data));
    this.pty.onExit(({ exitCode, signal }) => {
      this._exitCode = exitCode;
      this.pty = null;
      this.emit('exit', exitCode, signal);
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  async kill(signal: string = 'SIGTERM'): Promise<void> {
    if (!this.pty) return;
    this.pty.kill(signal);
    if (this.pty) {
      await new Promise<void>((resolve) => {
        const onExit = () => { this.removeListener('exit', onExit); resolve(); };
        this.on('exit', onExit);
      });
    }
  }
}
