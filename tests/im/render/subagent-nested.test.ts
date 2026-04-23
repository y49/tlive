import { describe, it, expect } from 'vitest';
import { renderSubagentBlock, subagentGlyph } from '../../../src/im/render/subagent-nested.js';

describe('subagent-nested', () => {
  it('empty → empty', () => {
    expect(renderSubagentBlock([])).toBe('');
  });

  it('renders running agent with 🤖', () => {
    const block = renderSubagentBlock([
      { agentId: 'a1', description: 'Do thing', done: false, ok: null },
    ]);
    expect(block).toContain('🤖');
    expect(block).toContain('Do thing');
  });

  it('renders done_ok as ✅ and done_err as ❌', () => {
    expect(subagentGlyph({ agentId: '1', description: 'x', done: true, ok: true })).toBe('✅');
    expect(subagentGlyph({ agentId: '1', description: 'x', done: true, ok: false })).toBe('❌');
  });

  it('truncates long descriptions and summaries', () => {
    const block = renderSubagentBlock([{
      agentId: 'a', description: 'a'.repeat(200), done: false, ok: null,
      latestSummary: 'b'.repeat(200),
    }]);
    expect(block.length).toBeLessThan(400);
    expect(block).toContain('…');
  });
});
