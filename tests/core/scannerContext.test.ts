import { describe, it, expect } from 'vitest';
import { ScannerContext } from '../../src/core/scannerContext.js';

describe('ScannerContext', () => {
  it('derives workspaceName from the last path segment', () => {
    const ctx = ScannerContext.fromWorkdir({
      sessionId: 'sid',
      workdir: '/home/alice/projects/foo',
      provider: 'claude',
      terminalUrl: 'http://host/?token=t',
    });
    expect(ctx.snapshot.workspaceName).toBe('foo');
    expect(ctx.snapshot.isLocal).toBe(true);
    expect(ctx.snapshot.provider).toBe('claude');
  });

  it('falls back to "unknown" when workdir has no segments', () => {
    const ctx = ScannerContext.fromWorkdir({
      sessionId: 'sid', workdir: '/', provider: 'codex', terminalUrl: 'http://x/',
    });
    expect(ctx.snapshot.workspaceName).toBe('unknown');
  });

  it('preserves all provided fields in snapshot', () => {
    const ctx = ScannerContext.fromWorkdir({
      sessionId: 'sid-xyz', workdir: '/a', provider: 'claude', terminalUrl: 'http://x/?token=q',
    });
    expect(ctx.snapshot.sessionId).toBe('sid-xyz');
    expect(ctx.snapshot.workdir).toBe('/a');
    expect(ctx.snapshot.terminalUrl).toBe('http://x/?token=q');
  });
});
