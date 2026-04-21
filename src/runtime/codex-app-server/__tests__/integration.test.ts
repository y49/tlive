import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { CodexAppServerProvider } from '../index.js';

function detectCodex(): boolean {
  try {
    const stdout = execFileSync('codex', ['--version'], { encoding: 'utf8' });
    const match = stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
    return !!match && match[1] >= '0.121.0';
  } catch {
    return false;
  }
}

const codexAvailable = detectCodex();

describe('CodexAppServerProvider — integration smoke', () => {
  it.skipIf(!codexAvailable)('trivial conversation turn produces non-zero token usage', async () => {
    const provider = new CodexAppServerProvider();
    expect(await provider.isAvailable()).toBe(true);
    const result = provider.streamChat({
      prompt: 'Say the single word OK',
      workingDirectory: process.cwd(),
      sessionId: undefined,
    });
    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    const reader = result.stream.getReader();
    const timer = setTimeout(() => reader.cancel(), 60000);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(value as any);
        if (value && (value as any).kind === 'query_result') break;
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    const queryResult = events.find(e => e.kind === 'query_result');
    expect(queryResult).toBeDefined();
    expect(queryResult).toMatchObject({ isError: false });
    // Non-zero token usage proves the fix
    const usage = (queryResult as any).usage;
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  }, 90000);
});
