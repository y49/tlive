// src/mcp/self/tools/memory.ts
//
// Workspace-scoped KV persistence at
// `~/.tlive/workspaces/<id>/memory/<key>.json`. Powers `tlive.memory.{get,set,list}`.
//
// Values are arbitrary JSON. Keys are restricted to `[A-Za-z0-9_.-]+` to keep
// safe filenames.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpTool, McpToolDeps } from '../deps.js';
import { jsonResult, errorResult, requireString, optionalString } from './util.js';

const KEY_RE = /^[A-Za-z0-9_.-]+$/;

function memoryDir(deps: McpToolDeps, workspaceId: string): string {
  const root = deps.dataDir ?? join(homedir(), '.tlive');
  return join(root, 'workspaces', workspaceId, 'memory');
}

async function readKey(deps: McpToolDeps, workspaceId: string, key: string): Promise<unknown> {
  const path = join(memoryDir(deps, workspaceId), `${key}.json`);
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeKey(deps: McpToolDeps, workspaceId: string, key: string, value: unknown): Promise<void> {
  const dir = memoryDir(deps, workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${key}.json`);
  await fs.writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function listKeys(deps: McpToolDeps, workspaceId: string, prefix?: string): Promise<Array<{ key: string; size: number }>> {
  const dir = memoryDir(deps, workspaceId);
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: Array<{ key: string; size: number }> = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const key = n.slice(0, -'.json'.length);
    if (prefix && !key.startsWith(prefix)) continue;
    const st = await fs.stat(join(dir, n)).catch(() => null);
    out.push({ key, size: st?.size ?? 0 });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function makeMemoryGetTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.memory.get',
      description: 'Read a workspace-scoped memory key. Returns null when missing.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const key = requireString(args, 'key');
      if (!KEY_RE.test(key)) return errorResult(`invalid key: ${key}`);
      const value = await readKey(deps, ctx.workspaceId, key);
      return jsonResult({ key, value });
    },
  };
}

export function makeMemorySetTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.memory.set',
      description: 'Write a workspace-scoped memory key.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, value: {} },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const key = requireString(args, 'key');
      if (!KEY_RE.test(key)) return errorResult(`invalid key: ${key}`);
      await writeKey(deps, ctx.workspaceId, key, args.value);
      return jsonResult({ ok: true, key });
    },
  };
}

export function makeMemoryListTool(deps: McpToolDeps): McpTool {
  return {
    definition: {
      name: 'tlive.memory.list',
      description: 'List workspace memory keys (optionally filtered by prefix).',
      inputSchema: {
        type: 'object',
        properties: { prefix: { type: 'string' } },
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const prefix = optionalString(args, 'prefix');
      const items = await listKeys(deps, ctx.workspaceId, prefix);
      return jsonResult({ items });
    },
  };
}
