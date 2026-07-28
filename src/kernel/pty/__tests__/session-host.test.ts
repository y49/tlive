import { describe, it, expect, vi } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHost, authoritativeSize } from '../session-host';

// Per-session socket: fs path on POSIX (directly in `dir`, no subdir), named
// pipe on win32. basename(dir) is unique per mkdtemp → collision-free pipe.
const sessSock = (dir: string, name: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\tlive-t-${basename(dir)}-${name}` : join(dir, `${name}.sock`);
import { FrameDecoder, FrameType, encodeAttach, encodeData, parseDims } from '../../web/stream-protocol.js';

describe('authoritativeSize', () => {
  it('defaults to 80x24 with no sources', () => {
    expect(authoritativeSize([])).toEqual({ cols: 80, rows: 24 });
  });
  it('ignores sources with no known size (cols/rows 0)', () => {
    expect(authoritativeSize([{ cols: 0, rows: 0, lastInputSeq: 5 }])).toEqual({ cols: 80, rows: 24 });
  });
  it('picks the source with the highest lastInputSeq (last typer wins)', () => {
    expect(authoritativeSize([
      { cols: 80, rows: 24, lastInputSeq: 1 },
      { cols: 120, rows: 40, lastInputSeq: 2 },
    ])).toEqual({ cols: 120, rows: 40 });
  });
  it('on a tie prefers the local TTY', () => {
    expect(authoritativeSize([
      { cols: 120, rows: 40, lastInputSeq: 0 },
      { cols: 80, rows: 24, lastInputSeq: 0, isLocal: true },
    ])).toEqual({ cols: 80, rows: 24 });
  });
  it('floors fractional dims and clamps oversized dims', () => {
    expect(authoritativeSize([{ cols: 80.7, rows: 24.9, lastInputSeq: 1 }])).toEqual({ cols: 80, rows: 24 });
    expect(authoritativeSize([{ cols: 99999, rows: 88888, lastInputSeq: 1 }])).toEqual({ cols: 1000, rows: 1000 });
  });
});

describe('SessionHost (socket-only, attachLocal:false)', () => {
  it('forwards client input into the pty and fans pty output back as data frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = sessSock(dir, 's');
    // cross-platform echoer: node piping stdin → stdout
    const host = new SessionHost({
      id: 't1',
      cmd: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir,
      sockPath,
      attachLocal: false,
    });
    await host.start();

    const received: Buffer[] = [];
    const dec = new FrameDecoder();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for echo')), 8000);
      const sock = createConnection(sockPath, () => {
        sock.write(encodeAttach(80, 24));
        sock.write(encodeData(Buffer.from('hello\n')));
      });
      sock.on('error', reject);
      sock.on('data', (chunk: Buffer) => {
        for (const f of dec.push(chunk)) {
          if (f.type === FrameType.Data) {
            received.push(f.payload);
            if (Buffer.concat(received).toString('utf8').includes('hello')) { clearTimeout(t); sock.end(); resolve(); }
          }
        }
      });
    });

    expect(Buffer.concat(received).toString('utf8')).toContain('hello');
    await host.stop();
  });

  it('pty size follows the last client that typed and broadcasts it to all clients', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = sessSock(dir, 's');
    // quiet pty: reads stdin (so input is consumed) but never echoes; stays alive.
    const host = new SessionHost({
      id: 't2', cmd: process.execPath,
      args: ['-e', 'process.stdin.resume();setInterval(()=>{},1<<30)'],
      cwd: dir, sockPath, attachLocal: false,
    });
    await host.start();

    // Resolve once this socket receives a Size frame matching {cols,rows}. Self-contained:
    // own decoder + removes its listener so concurrent/sequential waits don't cross-decode.
    const waitForSize = (sock: ReturnType<typeof createConnection>, cols: number, rows: number) =>
      new Promise<void>((resolve, reject) => {
        const dec = new FrameDecoder();
        const onData = (chunk: Buffer): void => {
          for (const f of dec.push(chunk)) {
            if (f.type === FrameType.Size) {
              const d = parseDims(f.payload);
              if (d.cols === cols && d.rows === rows) { cleanup(); resolve(); }
            }
          }
        };
        const cleanup = (): void => { clearTimeout(t); sock.off('data', onData); sock.off('error', reject); };
        const t = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for Size ${cols}x${rows}`)); }, 8000);
        sock.on('data', onData);
        sock.on('error', reject);
      });
    const a = createConnection(sockPath);
    const b = createConnection(sockPath);
    // Attach BEFORE the first write. A write that fails on a socket with no
    // 'error' listener is an uncaught exception, and on Windows named pipes a
    // write can fail with EAGAIN while the peer catches up — vitest then fails
    // the whole run on an unhandled error with every test green. waitForSize
    // attaches its own listener, but only later: the attach frames below go out
    // before it exists, and the sockets outlive the last wait. A real error
    // during a wait still rejects through that listener.
    for (const s of [a, b]) s.on('error', () => { /* teardown race, not a test failure */ });
    await new Promise<void>((r) => a.on('connect', () => r()));
    await new Promise<void>((r) => b.on('connect', () => r()));

    a.write(encodeAttach(80, 24));
    b.write(encodeAttach(120, 40));

    // B types → B (120x40) becomes authoritative → both clients get Size 120x40.
    const aGets = waitForSize(a, 120, 40);
    const bGets = waitForSize(b, 120, 40);
    b.write(encodeData(Buffer.from('x')));
    await Promise.all([aGets, bGets]);

    // A types → A (80x24) becomes authoritative → broadcast 80x24 to BOTH clients.
    const aGets2 = waitForSize(a, 80, 24);
    const bGets3 = waitForSize(b, 80, 24);
    a.write(encodeData(Buffer.from('y')));
    await Promise.all([aGets2, bGets3]);

    a.end(); b.end();
    await host.stop();
  });

  it('late joiner receives a snapshot of the screen printed BEFORE it attached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = sessSock(dir, 's');
    // prints once at startup, then stays alive silently
    const host = new SessionHost({
      id: 't3',
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("EARLY-SCREEN\\n"); setInterval(()=>{},1000);'],
      cwd: dir,
      sockPath,
      attachLocal: false,
    });
    await host.start();

    // Ordering the snapshot path needs: EARLY-SCREEN must reach the shadow
    // terminal BEFORE the real client attaches, otherwise the snapshot is empty,
    // the live output carries the string anyway, and this test passes without
    // touching the snapshot path at all.
    //
    // A throwaway client proves it: once EARLY-SCREEN has come back over the live
    // stream, pty.onData has already fed it to the shadow. onActivity cannot be
    // used for this — on Windows, ConPTY emits initialisation sequences before the
    // child writes anything, so an activity flip says nothing about child output.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('probe never saw EARLY-SCREEN')), 8000);
      const pdec = new FrameDecoder();
      let acc = '';
      const probe = createConnection(sockPath, () => { probe.write(encodeAttach(80, 24)); });
      probe.on('error', reject);
      probe.on('data', (chunk: Buffer) => {
        for (const f of pdec.push(chunk)) {
          if (f.type === FrameType.Data) {
            acc += f.payload.toString('utf8');
            if (acc.includes('EARLY-SCREEN')) {
              clearTimeout(t);
              probe.end();
              // Let the socket fully close before the late joiner connects, ensuring
              // the ordering guarantee is complete.
              setTimeout(resolve, 100);
            }
          }
        }
      });
    });

    const dec = new FrameDecoder();
    const got = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('late joiner got no snapshot')), 8000);
      const chunks: Buffer[] = [];
      const sock = createConnection(sockPath, () => { sock.write(encodeAttach(80, 24)); });
      sock.on('error', reject);
      sock.on('data', (chunk: Buffer) => {
        for (const f of dec.push(chunk)) {
          if (f.type === FrameType.Data) {
            chunks.push(f.payload);
            const s = Buffer.concat(chunks).toString('utf8');
            if (s.includes('EARLY-SCREEN')) { clearTimeout(t); sock.end(); resolve(s); }
          }
        }
      });
    });
    expect(got).toContain('EARLY-SCREEN');
    await host.stop();
  });


  it('injects TLIVE_SESSION=<id> into the wrapped process env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = sessSock(dir, 's');
    const host = new SessionHost({
      id: 'env-1',
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("TS=" + process.env.TLIVE_SESSION); setInterval(()=>{},1000);'],
      cwd: dir,
      sockPath,
      attachLocal: false,
    });
    await host.start();
    const dec = new FrameDecoder();
    const got = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no env output')), 8000);
      const chunks: Buffer[] = [];
      const sock = createConnection(sockPath, () => { sock.write(encodeAttach(80, 24)); });
      sock.on('error', reject);
      sock.on('data', (chunk: Buffer) => {
        for (const f of dec.push(chunk)) {
          if (f.type === FrameType.Data) {
            chunks.push(f.payload);
            const s = Buffer.concat(chunks).toString('utf8');
            if (s.includes('TS=env-1')) { clearTimeout(t); sock.end(); resolve(s); }
          }
        }
      });
    });
    expect(got).toContain('TS=env-1');
    await host.stop();
  });

  it.skipIf(process.platform === 'win32')('a silent child (no output) does not report as running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = sessSock(dir, 's');
    // child that consumes stdin but produces no output
    const host = new SessionHost({
      id: 'act-silent', cmd: process.execPath,
      args: ['-e', 'process.stdin.resume(); setInterval(()=>{},1000);'],
      cwd: dir, sockPath, attachLocal: false,
    });
    const flips: boolean[] = [];
    host.onActivity((a) => flips.push(a));
    await host.start();
    // Poll interval is 1s, first tick at ~1000ms. Give it a bit past
    // the first tick to ensure onActivity(true) has fired if the child
    // had emitted anything (it hasn't). This is an absence assertion —
    // a fixed delay proves that no true flip occurred.
    // Note: ConPTY emits initialisation sequences before any child output,
    // so a pty with no output does not exist on Windows and the assertion
    // is therefore meaningless rather than merely flaky. This is why the test
    // is skipped there.
    await new Promise((r) => setTimeout(r, 1200));
    expect(flips).not.toContain(true);  // never reported running
    await host.stop();
  });

  it('reports running on output then idle after silence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-host-'));
    const sockPath = sessSock(dir, 's');
    // print once at start, then go silent
    const host = new SessionHost({
      id: 'act-1', cmd: process.execPath,
      args: ['-e', 'process.stdout.write("hi\\n"); setInterval(()=>{},1000);'],
      cwd: dir, sockPath, attachLocal: false,
    });
    const flips: boolean[] = [];
    host.onActivity((a) => flips.push(a));
    await host.start();
    // within ~1s: running (true); after IDLE_MS(1.5s)+poll: idle (false)
    await new Promise((r) => setTimeout(r, 3200));
    expect(flips[0]).toBe(true);        // saw output → running
    expect(flips).toContain(false);     // then went idle
    await host.stop();
  });

  // Regression: stop() killed the pty but left the handle in place, so a client
  // Data frame already queued could still reach a pty whose win32 conin socket
  // had just been destroyed — an uncaught 'write EAGAIN'. See #59.
  it('clears the pty handle on stop so late input cannot reach a killed pty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-dispose-'));
    const host = new SessionHost({
      id: 'd1', cmd: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: dir, sockPath: sessSock(dir, 'd'), attachLocal: false,
    });
    await host.start();
    expect((host as unknown as { pty: unknown }).pty).not.toBeNull();

    await host.stop();
    expect((host as unknown as { pty: unknown }).pty).toBeNull();
  });

  it('clears the pty handle when the child exits on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-exit-'));
    const host = new SessionHost({
      id: 'd2', cmd: process.execPath, args: ['-e', 'process.exit(0)'],
      cwd: dir, sockPath: sessSock(dir, 'e'), attachLocal: false,
    });
    const exited = new Promise<number>((resolve) => host.onExit(resolve));
    await host.start();
    await exited;
    expect((host as unknown as { pty: unknown }).pty).toBeNull();
  });

});
