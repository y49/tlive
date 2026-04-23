// src/mcp/self/orchestrator.ts
//
// Pipeline runner: substitutes `{input}` and `{result[N]}` tokens in each
// step's promptTemplate, then invokes `executeStep(alias, prompt)`. Outputs
// accumulate into a `result[]` array available to later steps.
//
// Pipelines persist per-workspace at
// `~/.tlive/workspaces/<id>/pipelines.json`.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpToolDeps } from './deps.js';

export interface PipelineStep {
  alias: string;
  promptTemplate: string;
  waitFor?: 'complete' | 'first_response';
  onError?: 'abort' | 'skip' | 'retry';
}

export interface Pipeline {
  name: string;
  steps: PipelineStep[];
}

export interface RunPipelineResult {
  runId: string;
  outputs: string[];
}

export interface RunPipelineOptions {
  /**
   * Execute a single pipeline step. `waitFor` mirrors the `tlive.sessions.execute`
   * tool: 'complete' blocks until turn_end and returns accumulated assistant
   * text; 'first_response' returns the first assistant message. Real
   * production wiring uses `awaitTurnOutput` from `session-await.ts`.
   */
  executeStep: (alias: string, prompt: string, waitFor: 'complete' | 'first_response') => Promise<string>;
  maxRetries?: number;
}

/** Substitute `{input}` and `{result[N]}` placeholders. */
export function resolveTemplate(template: string, input: unknown, results: readonly string[]): string {
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  return template
    .replace(/\{input\}/g, inputStr)
    .replace(/\{result\[(\d+)\]\}/g, (_m, n: string) => results[Number(n)] ?? '');
}

export async function runPipeline(
  pipeline: Pipeline,
  input: unknown,
  opts: RunPipelineOptions,
): Promise<RunPipelineResult> {
  const runId = `run-${randomBytes(4).toString('hex')}`;
  const outputs: string[] = [];
  const maxRetries = opts.maxRetries ?? 1;

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i]!;
    const prompt = resolveTemplate(step.promptTemplate, input, outputs);
    const waitFor: 'complete' | 'first_response' = step.waitFor ?? 'complete';
    let attempt = 0;
    while (true) {
      try {
        const out = await opts.executeStep(step.alias, prompt, waitFor);
        outputs.push(out);
        break;
      } catch (err) {
        attempt += 1;
        const policy = step.onError ?? 'abort';
        if (policy === 'skip') {
          outputs.push(`<error:${(err as Error).message}>`);
          break;
        }
        if (policy === 'retry' && attempt < maxRetries) continue;
        if (policy === 'abort') {
          return { runId, outputs };
        }
        outputs.push(`<error:${(err as Error).message}>`);
        break;
      }
    }
  }
  return { runId, outputs };
}

// ---- Persistence --------------------------------------------------------------

function pipelineFile(deps: McpToolDeps, workspaceId: string): string {
  const root = deps.dataDir ?? join(homedir(), '.tlive');
  return join(root, 'workspaces', workspaceId, 'pipelines.json');
}

interface PipelineFile {
  pipelines: Pipeline[];
}

export async function loadAllPipelines(deps: McpToolDeps, workspaceId: string): Promise<Pipeline[]> {
  try {
    const raw = await fs.readFile(pipelineFile(deps, workspaceId), 'utf8');
    const parsed = JSON.parse(raw) as PipelineFile;
    return Array.isArray(parsed.pipelines) ? parsed.pipelines : [];
  } catch {
    return [];
  }
}

export async function loadPipeline(deps: McpToolDeps, workspaceId: string, name: string): Promise<Pipeline | null> {
  const all = await loadAllPipelines(deps, workspaceId);
  return all.find((p) => p.name === name) ?? null;
}

export async function savePipeline(deps: McpToolDeps, workspaceId: string, pipeline: Pipeline): Promise<void> {
  const file = pipelineFile(deps, workspaceId);
  await fs.mkdir(dirname(file), { recursive: true });
  const all = await loadAllPipelines(deps, workspaceId);
  const filtered = all.filter((p) => p.name !== pipeline.name);
  filtered.push(pipeline);
  await fs.writeFile(file, JSON.stringify({ pipelines: filtered }, null, 2), 'utf8');
}

export async function removePipeline(deps: McpToolDeps, workspaceId: string, name: string): Promise<boolean> {
  const all = await loadAllPipelines(deps, workspaceId);
  const filtered = all.filter((p) => p.name !== name);
  if (filtered.length === all.length) return false;
  const file = pipelineFile(deps, workspaceId);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pipelines: filtered }, null, 2), 'utf8');
  return true;
}
