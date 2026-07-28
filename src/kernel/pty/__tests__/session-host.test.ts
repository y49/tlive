import { describe, it, expect, vi } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHost, authoritativeSize } from '../session-host';

// Auto-mocked for the wiring test below: on Linux guardWindowsConinSocket is
// a no-op by design (see win-conin-guard.ts), so no black-box test can see
// whether session-host.ts still calls it. Every other test in this file
// spawns real ptys and never asserts on the guard, so replacing it with a
// no-op spy for the whole file doesn't change their behavior.
vi.mock('../win-conin-guard.js');
import { guardWindowsConinSocket } from '../win-conin-guard.js';

// Per-session socket: fs path on POSIX (directly in `dir`, no subdir), named
// pipe on win32. basename(dir) is unique per mkdtemp → collision-free pipe.
const sessSock = (dir: string, name: string): string =>
  process.platform === 'win32' ? `\\\\.\\pipe\\tlive-t-${basename(dir)}-${name}` : join(dir, `${name}.sock`);
import { FrameDecoder, FrameType, encodeAttach, encodeData, parseDims } from '../../web/stream-protocol.js';
import { until } from '../../__tests__/wait.js';

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

    // A client that is already watching the session. It stays attached for the rest
    // of the test: "late joiner" means "attached after the output happened", not
    // "the only client" — every client gets its own snapshot on its own first attach,
    // and the web terminal really does have tabs joining a session others are in.
    // The error handler goes on before the first write; see the comment in the
    // sizing test above for why.
    const probe = createConnection(sockPath);
    probe.on('error', () => { /* teardown race, not a test failure */ });
    await new Promise<void>((r) => probe.once('connect', () => r()));
    probe.write(encodeAttach(80, 24));

    // The precondition the snapshot path needs: EARLY-SCREEN must have reached the
    // shadow terminal BEFORE the client under test attaches. Otherwise the snapshot
    // is empty, the live stream carries the string anyway, and this test passes
    // without touching the snapshot path at all.
    //
    // Seeing EARLY-SCREEN arrive on a live client does NOT establish that: pty.onData
    // broadcasts to sockets synchronously, but xterm's write buffer parses on a later
    // macrotask, so serialize() can still return '' while those bytes are already on
    // the wire. Wait on the shadow's own content instead — the thing the snapshot is
    // built from. (onActivity is no use either: on Windows ConPTY emits initialisation
    // sequences before the child writes anything, so a flip says nothing about output.)
    const internals = host as unknown as { serializer: { serialize(): string } | null };
    await until(() => { expect(internals.serializer?.serialize() ?? '').toContain('EARLY-SCREEN'); });

    const dec = new FrameDecoder();
    const got = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('late joiner got no snapshot')), 8000);
      let firstDataPayload = '';
      let gotFirstData = false;
      const sock = createConnection(sockPath, () => { sock.write(encodeAttach(80, 24)); });
      sock.on('error', reject);
      sock.on('data', (chunk: Buffer) => {
        for (const f of dec.push(chunk)) {
          if (f.type === FrameType.Data && !gotFirstData) {
            // The first Data frame on a first attach is the snapshot (serializer.serialize).
            // Live output (from pty.onData) comes after.
            gotFirstData = true;
            firstDataPayload = f.payload.toString('utf8');
            clearTimeout(t);
            sock.end();
            resolve(firstDataPayload);
          }
        }
      });
    });
    expect(got).toContain('EARLY-SCREEN');
    probe.end();
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
    // Not an absence-assertion violation: the `false` flip below is a genuine
    // arrival (the first poll tick, with no output yet, always reports idle),
    // so until() has something real to wait on. The `not.toContain(true)`
    // check afterwards is then made against state that can no longer change,
    // because this test's child never writes — there is no later tick that
    // could still flip it to running.
    // Note: ConPTY emits initialisation sequences before any child output,
    // so a pty with no output does not exist on Windows and the assertion
    // is therefore meaningless rather than merely flaky. This is why the test
    // is skipped there.
    await until(() => { expect(flips).toContain(false); }); // a tick demonstrably ran…
    expect(flips).not.toContain(true);                      // …and it reported idle
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
    // Both are arrivals — wait on each instead of a fixed sleep. (flips[0] is
    // no longer guaranteed to be `true` by construction: it now races the
    // child's first byte against the poll tick at spawn+~1000ms.)
    await until(() => { expect(flips).toContain(true); });
    await until(() => { expect(flips).toContain(false); });
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

  // Regression guard for #59: guardWindowsConinSocket() is a no-op on Linux
  // by design, so nothing black-box can tell whether start() still calls it —
  // dropping the call here would leave the whole suite green. Assert the
  // wiring directly via the mocked import instead.
  it('wires guardWindowsConinSocket into start()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlive-guard-'));
    const host = new SessionHost({
      id: 'guard-1', cmd: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: dir, sockPath: sessSock(dir, 'g'), attachLocal: false,
    });
    // Captured immediately before the action under test, not asserted as an
    // absolute count: other tests in this file also call start() against the
    // same auto-mocked import, so only the delta from this one call is
    // meaningful.
    const before = vi.mocked(guardWindowsConinSocket).mock.calls.length;
    await host.start();
    expect(vi.mocked(guardWindowsConinSocket).mock.calls.length).toBe(before + 1);
    await host.stop();
  });

});
