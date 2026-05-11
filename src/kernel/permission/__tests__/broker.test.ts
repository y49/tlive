import { describe, it, expect } from 'vitest';
import { PermissionBroker } from '../broker';

describe('PermissionBroker', () => {
  it('request → wait → answer round-trip', async () => {
    const b = new PermissionBroker();
    let pushed: { requestId: string; toolName: string } | null = null;
    b.onRequest((req) => { pushed = { requestId: req.requestId, toolName: req.toolName }; });

    const promise = b.request({ toolName: 'Bash', input: { cmd: 'ls' }, source: 'mcp' });
    expect(pushed).not.toBeNull();
    b.answer(pushed!.requestId, true);
    const r = await promise;
    expect(r).toBe(true);
  });

  it('multiple parallel requests', async () => {
    const b = new PermissionBroker();
    const ids: string[] = [];
    b.onRequest((req) => ids.push(req.requestId));

    const p1 = b.request({ toolName: 'A', input: {}, source: 'mcp' });
    const p2 = b.request({ toolName: 'B', input: {}, source: 'sdk' });
    expect(ids).toHaveLength(2);

    b.answer(ids[1], true);
    b.answer(ids[0], false);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(false);
    expect(r2).toBe(true);
  });

  it('answer for unknown id is silent no-op', () => {
    const b = new PermissionBroker();
    expect(() => b.answer('unknown', true)).not.toThrow();
  });

  it('source field tracks dual entry path (mcp vs sdk)', async () => {
    const b = new PermissionBroker();
    const sources: string[] = [];
    b.onRequest((req) => { sources.push(req.source); b.answer(req.requestId, true); });
    await b.request({ toolName: 'X', input: {}, source: 'mcp' });
    await b.request({ toolName: 'Y', input: {}, source: 'sdk' });
    expect(sources).toEqual(['mcp', 'sdk']);
  });
});
