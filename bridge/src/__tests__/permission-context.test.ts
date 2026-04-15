import { describe, it, expect } from 'vitest';
import { PermissionContextCollector } from '../engine/permission-context.js';

describe('PermissionContextCollector', () => {
  it('tracks latest reasoning and recent tools', () => {
    const c = new PermissionContextCollector({ maxTools: 5 });
    c.observe({ kind: 'reasoning_complete', text: 'My first reasoning' });
    c.observe({ kind: 'tool_start', id: 't1', name: 'Read', input: { path: 'a.ts' } });
    c.observe({ kind: 'tool_start', id: 't2', name: 'Edit', input: { path: 'b.ts' } });

    const ctx = c.snapshot();
    expect(ctx.reasoning).toBe('My first reasoning');
    expect(ctx.recentTools).toHaveLength(2);
  });

  it('limits recent tools to maxTools', () => {
    const c = new PermissionContextCollector({ maxTools: 3 });
    for (let i = 0; i < 10; i++) {
      c.observe({ kind: 'tool_start', id: 't' + i, name: 'Read', input: { path: 'f' + i } });
    }
    const ctx = c.snapshot();
    expect(ctx.recentTools).toHaveLength(3);
    // Most recent at end
    expect(ctx.recentTools[2].name).toBe('Read');
  });

  it('reset clears state (called on turn boundary)', () => {
    const c = new PermissionContextCollector({ maxTools: 5 });
    c.observe({ kind: 'reasoning_complete', text: 'x' });
    c.reset();
    expect(c.snapshot().reasoning).toBeUndefined();
    expect(c.snapshot().recentTools).toHaveLength(0);
  });
});
