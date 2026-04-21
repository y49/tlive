import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { CodexAppServerRuntime } from '../../src/runtime/codex-app-server/index.js';
import type { NotificationEvent } from '../../src/runtime/events.js';

describe('CodexAppServerRuntime', () => {
  it('start throws if called twice', async () => {
    const rt = new CodexAppServerRuntime({ spawnSubprocess: () => makeFakeChild() });
    const ac = new AbortController();
    // Fire the first start without awaiting — the fake transport never replies to
    // initialize(), so start() stays pending. We only care that the re-entry guard
    // fires on the second call (which is synchronous — `this.started` is set
    // before the first await).
    const first = rt.start({ sessionId: 's', workdir: '/x', signal: ac.signal });
    first.catch(() => {});  // prevent unhandled rejection if the fake ever errors
    await expect(rt.start({ sessionId: 's', workdir: '/x', signal: ac.signal }))
      .rejects.toThrow(/already started/);
    ac.abort();
  });

  it('has provider="codex"', () => {
    const rt = new CodexAppServerRuntime({ spawnSubprocess: () => makeFakeChild() });
    expect(rt.provider).toBe('codex');
  });

  it('registers event/permission/usage listeners; onEvent returns an unsubscribe', () => {
    const rt = new CodexAppServerRuntime({ spawnSubprocess: () => makeFakeChild() });
    const calls: unknown[] = [];
    const unsub = rt.onEvent((e) => calls.push(e));
    expect(typeof unsub).toBe('function');
    unsub();
    // No easy way to emit without starting the runtime; this just asserts the shape.
  });

  it('cleans up transport and client when init-phase request rejects (C-1)', async () => {
    // Drive initialize to completion, then have thread/start return an error.
    // The catch branch in start() must: fire exactly one error event, mark
    // closed=true, and close() the client+transport so the child doesn't leak.
    const mock = buildMockedRuntime();
    const events: NotificationEvent[] = [];
    mock.rt.onEvent((e) => events.push(e));
    const ac = new AbortController();
    const startPromise = mock.rt.start({
      sessionId: '',
      workdir: '/tmp',
      signal: ac.signal,
    });
    startPromise.catch(() => {});  // suppress unhandled
    await flushMicro();

    const initMsg = mock.sent.find(m => m.method === 'initialize');
    expect(initMsg).toBeDefined();
    mock.reply({ id: initMsg!.id, result: { capabilities: {} } });
    await flushMicro();

    // Empty sessionId is falsy, so start() takes the thread/start branch.
    const threadMsg = mock.sent.find(m => m.method === 'thread/start');
    expect(threadMsg).toBeDefined();
    // Reject thread/start with a JSON-RPC error.
    mock.reply({
      id: threadMsg!.id,
      error: { code: -32000, message: 'simulated thread/start failure' },
    });
    // The init-catch in start() calls client.close() → transport.close(),
    // which awaits the child 'exit' event. Simulate that so cleanup promptly
    // completes — in a real codex process, closing stdin drives child exit.
    await flushMicro();
    mock.triggerExit(0, null);

    await expect(startPromise).rejects.toThrow(/simulated thread\/start failure/);
    // Exactly one error event from the init catch (transport onExit doesn't
    // fire here because we never triggered child 'exit').
    const errs = events.filter(e => e.kind === 'error');
    expect(errs.length).toBe(1);
    expect((errs[0] as { message: string }).message).toMatch(/simulated thread\/start failure/);
    // Transport.close was invoked — stdin.end() was called.
    expect(mock.stdinEnded).toBe(true);
    // sendInput should now reject because closed=true.
    await expect(mock.rt.sendInput('hi')).rejects.toThrow(/runtime closed/);
  });

  it('stop() issues turn/interrupt before closing transport when a turn is active (C-3)', async () => {
    const mock = buildMockedRuntime();
    const ac = new AbortController();
    const startPromise = mock.rt.start({
      sessionId: '',
      workdir: '/tmp',
      initialPrompt: 'hello',
      signal: ac.signal,
    });
    startPromise.catch(() => {});
    await flushMicro();

    // initialize → result
    const initMsg = mock.sent.find(m => m.method === 'initialize');
    mock.reply({ id: initMsg!.id, result: { capabilities: {} } });
    await flushMicro();

    // thread/start → result
    const threadMsg = mock.sent.find(m => m.method === 'thread/start');
    mock.reply({ id: threadMsg!.id, result: { thread: { id: 'thread-abc' } } });
    await flushMicro();

    // turn/start → result + notification carrying turn id
    const turnMsg = mock.sent.find(m => m.method === 'turn/start');
    expect(turnMsg).toBeDefined();
    mock.reply({ id: turnMsg!.id, result: { turn: { id: 'turn-42' } } });
    mock.reply({
      method: 'turn/started',
      params: { threadId: 'thread-abc', turn: { id: 'turn-42' } },
    });
    await flushMicro();
    await startPromise;

    // Now stop — should issue turn/interrupt with the captured turn id.
    const stopPromise = mock.rt.stop();
    stopPromise.catch(() => {});
    await flushMicro();
    const interruptMsg = mock.sent.find(m => m.method === 'turn/interrupt');
    expect(interruptMsg).toBeDefined();
    expect(interruptMsg!.params).toMatchObject({
      threadId: 'thread-abc',
      turnId: 'turn-42',
    });
    // Reply to the interrupt so stop() can progress past the await, then
    // trigger child exit so transport.close() resolves.
    mock.reply({ id: interruptMsg!.id, result: {} });
    await flushMicro();
    mock.triggerExit(0, null);
    await stopPromise;
  });
});

// ---- helpers ----------------------------------------------------------------

function makeFakeChild(): any {
  return {
    stdin: { write: () => true, on: () => {}, end: () => {} },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  };
}

async function flushMicro(): Promise<void> {
  // Multiple turns to let setImmediate/Promise chains settle.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

/**
 * Builds a CodexAppServerRuntime wired to an in-memory stdio pair. Returns
 * helpers to inspect what the runtime sent and to inject server replies /
 * notifications.
 */
function buildMockedRuntime() {
  const stdout = new Readable({ read() {} });
  const stdinWrites: Buffer[] = [];
  let stdinEnded = false;
  const stdin = {
    write: (chunk: Buffer | string) => {
      stdinWrites.push(Buffer.from(chunk as any));
      return true;
    },
    end: () => { stdinEnded = true; },
    on: () => {},
  };
  const listeners: Record<string, Array<(...a: any[]) => void>> = { exit: [], error: [] };
  const child: any = {
    stdout, stdin,
    kill: vi.fn(),
    on: (ev: string, cb: any) => { (listeners[ev] ??= []).push(cb); },
    once: (ev: string, cb: any) => { (listeners[ev] ??= []).push(cb); },
    emit: (ev: string, ...args: any[]) => { (listeners[ev] ?? []).forEach(l => l(...args)); },
  };
  const sent: any[] = [];
  const parseWrites = () => {
    const combined = Buffer.concat(stdinWrites).toString('utf8');
    stdinWrites.length = 0;
    for (const line of combined.split('\n')) {
      if (line.trim().length > 0) {
        try { sent.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    }
  };
  const origWrite = stdin.write;
  (stdin as any).write = (chunk: Buffer | string) => {
    const r = origWrite(chunk);
    parseWrites();
    return r;
  };
  const rt = new CodexAppServerRuntime({ spawnSubprocess: () => child });
  const reply = (msg: unknown) => stdout.push(JSON.stringify(msg) + '\n');
  const triggerExit = (code: number | null, signal: string | null) =>
    child.emit('exit', code, signal);
  return {
    rt,
    reply,
    sent,
    triggerExit,
    get stdinEnded() { return stdinEnded; },
  };
}
