// src/mcp/bundled/shell-safe/server.ts
//
// `shell-safe` bundled MCP server — read-only shell subset exposed as
// distinct tools. Ships with four commands in-scope (ls / find / grep / cat).
// Future-scope: head / tail / wc / awk / sed -n.
//
// Safety: argv whitelist — no shell interpolation, no pipes, no I/O
// redirection. Subprocess spawn directly via node:child_process.execFile.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(execFile);

export interface ShellToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 1_000_000;

function runCmd(cmd: string, args: string[], cwd?: string): Promise<ShellToolResult> {
  return execP(cmd, args, { cwd, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: DEFAULT_MAX_BUFFER, windowsHide: true })
    .then((out) => ({ content: [{ type: 'text' as const, text: out.stdout }] }))
    .catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => ({
      content: [{ type: 'text' as const, text: err.stderr || err.message || String(err) }],
      isError: true,
    }));
}

export function makeLsTool() {
  return {
    definition: {
      name: 'shell.ls',
      description: 'List a directory. Flags limited to -a / -l / -h / -R.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' },
          flags: { type: 'array', items: { type: 'string', enum: ['-a', '-l', '-h', '-R'] } },
        },
        required: ['path'],
      },
    },
    async handler(args: Record<string, unknown>): Promise<ShellToolResult> {
      const path = String(args.path);
      const flags = Array.isArray(args.flags) ? (args.flags as string[]) : [];
      return runCmd('ls', [...flags, path]);
    },
  };
}

export function makeFindTool() {
  return {
    definition: {
      name: 'shell.find',
      description: 'Find files by pattern. Flags: -name, -type, -maxdepth.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['f', 'd'] },
          maxDepth: { type: 'number' },
        },
        required: ['path'],
      },
    },
    async handler(args: Record<string, unknown>): Promise<ShellToolResult> {
      const path = String(args.path);
      const cmd: string[] = [path];
      if (typeof args.maxDepth === 'number') cmd.push('-maxdepth', String(args.maxDepth));
      if (typeof args.type === 'string') cmd.push('-type', String(args.type));
      if (typeof args.name === 'string') cmd.push('-name', String(args.name));
      return runCmd('find', cmd);
    },
  };
}

export function makeGrepTool() {
  return {
    definition: {
      name: 'shell.grep',
      description: 'Grep for a pattern. Flags: -i, -n, -r, -l, -c.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          flags: { type: 'array', items: { type: 'string', enum: ['-i', '-n', '-r', '-l', '-c'] } },
        },
        required: ['pattern', 'path'],
      },
    },
    async handler(args: Record<string, unknown>): Promise<ShellToolResult> {
      const pattern = String(args.pattern);
      const path = String(args.path);
      const flags = Array.isArray(args.flags) ? (args.flags as string[]) : [];
      return runCmd('grep', [...flags, '--', pattern, path]);
    },
  };
}

export function makeCatTool() {
  return {
    definition: {
      name: 'shell.cat',
      description: 'Cat a file. Single path only.',
      inputSchema: {
        type: 'object' as const,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async handler(args: Record<string, unknown>): Promise<ShellToolResult> {
      const path = String(args.path);
      return runCmd('cat', [path]);
    },
  };
}

export function makeShellSafeTools() {
  return [makeLsTool(), makeFindTool(), makeGrepTool(), makeCatTool()];
}
