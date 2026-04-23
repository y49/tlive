import { describe, it, expect } from 'vitest';
import { renderParallelBlock, summarizeParallel, parallelToolGlyph } from '../../../src/im/render/parallel-tools.js';

describe('parallel-tools', () => {
  it('renders empty block as empty string', () => {
    expect(renderParallelBlock([])).toBe('');
  });

  it('summarizes running/done/failed', () => {
    const s = summarizeParallel([
      { toolUseId: '1', toolName: 'A', status: 'running' },
      { toolUseId: '2', toolName: 'B', status: 'done_ok' },
      { toolUseId: '3', toolName: 'C', status: 'done_err' },
    ]);
    expect(s).toEqual({ total: 3, completed: 2, failed: 1, running: 1 });
  });

  it('sorts by batchIndex', () => {
    const block = renderParallelBlock([
      { toolUseId: '1', toolName: 'B', status: 'done_ok', batchIndex: 2 },
      { toolUseId: '2', toolName: 'A', status: 'running', batchIndex: 1 },
    ]);
    const firstTool = block.split('\n')[1];
    expect(firstTool).toContain('A');
  });

  it('glyphs', () => {
    expect(parallelToolGlyph('running')).toBe('🔧');
    expect(parallelToolGlyph('done_ok')).toBe('✅');
    expect(parallelToolGlyph('done_err')).toBe('❌');
  });
});
