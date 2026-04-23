// tests/mcp/self/orchestrator.test.ts
//
// Pipeline runner — token substitution + error policies + persistence.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildHarness, type McpTestHarness } from '../helpers.js';
import {
  runPipeline, resolveTemplate, savePipeline, loadPipeline, removePipeline,
} from '../../../src/mcp/self/orchestrator.js';

describe('orchestrator', () => {
  let harness: McpTestHarness;
  beforeEach(async () => { harness = await buildHarness(); });
  afterEach(async () => { await rm(harness.root, { recursive: true, force: true }); });

  it('resolveTemplate substitutes {input} and {result[N]}', () => {
    expect(resolveTemplate('hello {input}!', 'world', [])).toBe('hello world!');
    expect(resolveTemplate('{result[0]} + {result[1]}', null, ['A', 'B'])).toBe('A + B');
  });

  it('runs a multi-step pipeline with result chaining', async () => {
    const outputs: string[] = [];
    const result = await runPipeline(
      {
        name: 'test',
        steps: [
          { alias: 'a', promptTemplate: 'step1: {input}' },
          { alias: 'b', promptTemplate: 'step2: {result[0]}' },
        ],
      },
      'hi',
      {
        executeStep: async (alias, prompt) => {
          outputs.push(prompt);
          return `out-${alias}`;
        },
      },
    );
    expect(outputs).toEqual(['step1: hi', 'step2: out-a']);
    expect(result.outputs).toEqual(['out-a', 'out-b']);
  });

  it('abort policy halts pipeline after error', async () => {
    const executeStep = vi.fn()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('third');
    const res = await runPipeline(
      {
        name: 't',
        steps: [
          { alias: 'a', promptTemplate: 'x' },
          { alias: 'b', promptTemplate: 'y', onError: 'abort' },
          { alias: 'c', promptTemplate: 'z' },
        ],
      },
      null,
      { executeStep },
    );
    expect(res.outputs).toEqual(['first']);
  });

  it('skip policy records error but continues', async () => {
    const executeStep = vi.fn()
      .mockResolvedValueOnce('ok1')
      .mockRejectedValueOnce(new Error('kaboom'))
      .mockResolvedValueOnce('ok3');
    const res = await runPipeline(
      {
        name: 't',
        steps: [
          { alias: 'a', promptTemplate: 'x' },
          { alias: 'b', promptTemplate: 'y', onError: 'skip' },
          { alias: 'c', promptTemplate: 'z' },
        ],
      },
      null,
      { executeStep },
    );
    expect(res.outputs).toEqual(['ok1', '<error:kaboom>', 'ok3']);
  });

  it('persistence round-trip', async () => {
    const ws = harness.deps.workspaces.create({ name: 'W', workdir: '/W' });
    const pipeline = { name: 'p1', steps: [{ alias: 'a', promptTemplate: 'x' }] };
    await savePipeline(harness.deps, ws.id, pipeline);
    const loaded = await loadPipeline(harness.deps, ws.id, 'p1');
    expect(loaded).toEqual(pipeline);
    expect(await removePipeline(harness.deps, ws.id, 'p1')).toBe(true);
    expect(await loadPipeline(harness.deps, ws.id, 'p1')).toBeNull();
  });
});
