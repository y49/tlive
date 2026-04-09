import { describe, it, expect } from 'vitest';
import { ThinkingTracker } from '../../src/core/thinkingTracker.js';

describe('ThinkingTracker', () => {
  it('emits thinking=true on tool_use', () => {
    const tracker = new ThinkingTracker();
    const changes: boolean[] = [];
    tracker.on('change', (v: boolean) => changes.push(v));
    tracker.trackToolUse('tu-1');
    expect(tracker.isThinking).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('debounces thinking=false after tool_result', async () => {
    const tracker = new ThinkingTracker();
    tracker.trackToolUse('tu-1');
    tracker.trackToolResult('tu-1');
    expect(tracker.isThinking).toBe(true); // still thinking during debounce
    await new Promise(r => setTimeout(r, 600));
    expect(tracker.isThinking).toBe(false);
  });

  it('stays thinking if new tool_use arrives during debounce', async () => {
    const tracker = new ThinkingTracker();
    tracker.trackToolUse('tu-1');
    tracker.trackToolResult('tu-1');
    await new Promise(r => setTimeout(r, 200));
    tracker.trackToolUse('tu-2');
    await new Promise(r => setTimeout(r, 500));
    expect(tracker.isThinking).toBe(true);
  });

  it('clears thinking on assistant message', () => {
    const tracker = new ThinkingTracker();
    tracker.trackToolUse('tu-1');
    tracker.trackAssistantMessage();
    expect(tracker.isThinking).toBe(false);
  });
});
