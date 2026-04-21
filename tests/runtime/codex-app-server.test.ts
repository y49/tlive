import { describe, it, expect } from 'vitest';
import { CodexAppServerRuntime } from '../../src/runtime/codex-app-server/index.js';

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
});

function makeFakeChild(): any {
  return {
    stdin: { write: () => true, on: () => {}, end: () => {} },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  };
}
