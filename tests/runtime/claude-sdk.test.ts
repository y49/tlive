import { describe, it, expect } from 'vitest';
import { ClaudeSdkRuntime } from '../../src/runtime/claude-sdk.js';
import type { PermissionRequest } from '../../src/runtime/types.js';

/** Build a fake query() that yields the provided frames and collects canUseTool invocations. */
function fakeQuery(frames: unknown[]) {
  let capturedCanUseTool: ((name: string, input: any, options?: any) => Promise<any>) | null = null;
  const fn = (args: any) => {
    capturedCanUseTool = args.options.canUseTool;
    // Consume prompt generator in background (we don't rely on its output for these tests)
    (async () => { for await (const _ of args.prompt) { /* drain */ } })();
    async function* iter() {
      for (const f of frames) yield f;
    }
    return iter();
  };
  return { fn, get canUseTool() { return capturedCanUseTool!; } };
}

describe('ClaudeSdkRuntime', () => {
  it('start throws if called twice', async () => {
    const q = fakeQuery([]);
    const rt = new ClaudeSdkRuntime({ query: q.fn as any });
    const ac = new AbortController();
    await rt.start({ sessionId: 's', workdir: '/x', signal: ac.signal });
    await expect(rt.start({ sessionId: 's', workdir: '/x', signal: ac.signal })).rejects.toThrow(/already started/);
  });

  it('emits adapted events from the SDK stream', async () => {
    const q = fakeQuery([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', result: 'done', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, duration_ms: 10 },
    ]);
    const rt = new ClaudeSdkRuntime({ query: q.fn as any });
    const events: any[] = [];
    rt.onEvent((e) => events.push(e));
    const usages: any[] = [];
    rt.onUsage((u) => usages.push(u));
    await rt.start({ sessionId: 's', workdir: '/x', signal: new AbortController().signal });
    // Wait for background consumer
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.kind)).toContain('activity_text');
    expect(events.map((e) => e.kind)).toContain('session_complete');
    expect(usages).toHaveLength(1);
  });

  it('canUseTool emits PermissionRequest and blocks until resolve', async () => {
    const q = fakeQuery([]);
    const rt = new ClaudeSdkRuntime({ query: q.fn as any });
    const requests: PermissionRequest[] = [];
    rt.onPermissionRequest((r) => requests.push(r));
    await rt.start({ sessionId: 'sess', workdir: '/x', signal: new AbortController().signal });

    const sdkPromise = q.canUseTool('Bash', { command: 'ls' });
    // Give the emit a chance to propagate
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toHaveLength(1);
    expect(requests[0].toolName).toBe('Bash');
    expect(requests[0].id.startsWith('sess:')).toBe(true);

    requests[0].resolve('allow');
    const result = await sdkPromise;
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('deny translates to behavior: deny', async () => {
    const q = fakeQuery([]);
    const rt = new ClaudeSdkRuntime({ query: q.fn as any });
    const requests: PermissionRequest[] = [];
    rt.onPermissionRequest((r) => requests.push(r));
    await rt.start({ sessionId: 'sess', workdir: '/x', signal: new AbortController().signal });
    const sdkPromise = q.canUseTool('Bash', {});
    await new Promise((r) => setTimeout(r, 10));
    requests[0].resolve('deny');
    const result = await sdkPromise;
    expect(result).toEqual({ behavior: 'deny', message: 'Denied by user' });
  });

  it('sendInput queues messages; abort closes runtime', async () => {
    const q = fakeQuery([]);
    const rt = new ClaudeSdkRuntime({ query: q.fn as any });
    const ac = new AbortController();
    await rt.start({ sessionId: 's', workdir: '/x', signal: ac.signal });
    await rt.sendInput('hi');
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    await expect(rt.sendInput('later')).rejects.toThrow(/closed/);
  });

  it('mints a short local toolUseId and forwards suggestions on allow_always', async () => {
    const q = fakeQuery([]);
    const rt = new ClaudeSdkRuntime({ query: q.fn as any });
    const requests: PermissionRequest[] = [];
    rt.onPermissionRequest((r) => requests.push(r));
    await rt.start({ sessionId: 'sess', workdir: '/x', signal: new AbortController().signal });
    const sdkPromise = q.canUseTool('Bash', { cmd: 'ls' }, {
      toolUseID: 'tu-from-sdk', suggestions: [{ type: 'addRules', rules: ['Bash'] }],
    });
    await new Promise((r) => setTimeout(r, 10));
    // Permission id shape: `${sessionId}:${shortHex8}` — the SDK's native
    // options.toolUseID is discarded to keep callback_data under 53 bytes.
    expect(requests[0].id.startsWith('sess:')).toBe(true);
    expect(requests[0].id.slice('sess:'.length)).toMatch(/^[0-9a-f]{8}$/);
    requests[0].resolve('allow_always');
    const result = await sdkPromise;
    expect(result).toMatchObject({
      behavior: 'allow', updatedInput: { cmd: 'ls' },
      updatedPermissions: [{ type: 'addRules', rules: ['Bash'] }],
    });
  });

  it('consume() emits error OR session_complete, not both, on mid-stream failure', async () => {
    async function* badStream() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
      throw new Error('boom');
    }
    const fn = (_args: any) => badStream();
    const rt = new ClaudeSdkRuntime({ query: fn as any });
    const events: any[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.start({ sessionId: 's', workdir: '/x', signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('error');
    expect(kinds).not.toContain('session_complete');
  });
});
