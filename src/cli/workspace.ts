// src/cli/workspace.ts — `tlive workspace <add|list|remove> [args]`
//
// Workspace registration via IPC. Talks to a running daemon; no daemon
// restart needed. The daemon's WorkspaceManager is the single source of
// truth, so all three subverbs are thin shells around the existing IPC
// handlers (`workspace.add`/`workspace.list`/`workspace.remove`).
//
// Spec §9 — desktop entry point for workspace registration. Power users
// with SSH access live here; IM users use `/workspace` `[+ 新增]`.

import { resolve } from 'node:path';
import { request as defaultRequest, ensureDaemonRunning } from '../ipc/client.js';
import type { IpcRequest, IpcResponse } from '../ipc/protocol.js';

/** Injection seam for tests — production calls the real IPC client. */
export type RequestFn = (req: IpcRequest) => Promise<IpcResponse>;

export interface WorkspaceCommandDeps {
  /** Override for the IPC `request()` call (tests). */
  request?: RequestFn;
  /** Override for the daemon-ensure step (tests typically supply a no-op). */
  ensureRunning?: () => Promise<void>;
  /** Stdin reader for the remove-confirmation prompt (tests). */
  readLine?: () => Promise<string>;
}

export async function workspaceCommand(
  args: string[],
  deps: WorkspaceCommandDeps = {},
): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return;
  }

  const ensure = deps.ensureRunning ?? ensureDaemonRunning;
  const request: RequestFn = deps.request ?? defaultRequest;
  const readLineFn = deps.readLine ?? readLineFromStdin;

  await ensure();

  switch (sub) {
    case 'add':    await runAdd(args.slice(1), request); return;
    case 'list':   await runList(request); return;
    case 'remove': await runRemove(args.slice(1), request, readLineFn); return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      printUsage();
      process.exit(2);
  }
}

function printUsage(): void {
  process.stderr.write(
`Usage:
  tlive workspace add [<path>] [--name <n>] [--admin <userId>]
      Register a workspace. Path defaults to cwd. Name defaults to basename(path).
  tlive workspace list
      Show all registered workspaces.
  tlive workspace remove <id|name> [-y]
      Remove a workspace. Prompts confirmation unless -y/--yes is given.
`);
}

async function runAdd(args: string[], request: RequestFn): Promise<void> {
  const flags = parseFlags(args);
  const workdir = resolve(typeof flags.positional[0] === 'string' ? flags.positional[0] : process.cwd());
  const name = typeof flags.flags.name === 'string' ? flags.flags.name : basenameOf(workdir);
  const admin = typeof flags.flags.admin === 'string' ? flags.flags.admin : undefined;

  // The dispatcher accepts a partial workspace shape (name/workdir/etc.)
  // but the protocol type is the full TliveConfigV1.workspaces[number].
  // We construct just the fields the handler reads + roles for admin —
  // the WorkspaceManager fills the rest with defaults.
  const workspace = {
    name,
    workdir,
    ...(admin ? { roles: { [admin]: 'admin' as const }, defaultRole: 'observer' as const } : {}),
  };

  const resp = await request({
    kind: 'workspace.add',
    // Cast: the handler tolerates partial shapes (no id/defaults/budget).
    workspace: workspace as never,
  });

  if (resp.kind === 'workspace.added') {
    const shortId = resp.workspaceId.slice(0, 8);
    process.stdout.write(`Created workspace (id: ${shortId}, workdir: ${workdir})\n`);
    if (!admin) {
      process.stdout.write(`   Admin not set - claim from any IM chat with /workspace.\n`);
    }
    return;
  }
  if (resp.kind === 'error') {
    process.stderr.write(`error: ${resp.message}\n`);
    process.exit(1);
    return;
  }
  process.stderr.write(`error: unexpected response ${resp.kind}\n`);
  process.exit(1);
}

async function runList(request: RequestFn): Promise<void> {
  const resp = await request({ kind: 'workspace.list' });
  if (resp.kind === 'error') {
    process.stderr.write(`error: ${resp.message}\n`);
    process.exit(1);
    return;
  }
  if (resp.kind !== 'workspace.list') {
    process.stderr.write(`error: unexpected response ${resp.kind}\n`);
    process.exit(1);
    return;
  }
  if (resp.workspaces.length === 0) {
    process.stdout.write('No workspaces registered. Try: tlive workspace add\n');
    return;
  }

  const headers = ['NAME', 'WORKDIR', 'ADMIN', 'BINDINGS'];
  const rows = resp.workspaces.map((ws) => [
    ws.name,
    ws.workdir,
    ws.admin ?? '(unclaimed)',
    String(ws.bindings),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ');
  process.stdout.write(fmt(headers) + '\n');
  for (const r of rows) process.stdout.write(fmt(r) + '\n');
}

async function runRemove(
  args: string[],
  request: RequestFn,
  readLine: () => Promise<string>,
): Promise<void> {
  const flags = parseFlags(args);
  const idOrName = flags.positional[0];
  if (!idOrName) {
    process.stderr.write('usage: tlive workspace remove <id|name> [-y]\n');
    process.exit(2);
    return;
  }
  const autoYes = flags.flags.yes === true || flags.flags.y === true;
  if (!autoYes) {
    process.stdout.write(`Will remove workspace "${idOrName}". Continue? [y/N] `);
    const answer = (await readLine()).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      process.stdout.write('Aborted.\n');
      return;
    }
  }
  const resp = await request({ kind: 'workspace.remove', idOrName });
  if (resp.kind === 'workspace.removed') {
    if (resp.ok) {
      process.stdout.write('Removed\n');
      return;
    }
    process.stderr.write(`${resp.reason ?? 'failed'}\n`);
    process.exit(1);
    return;
  }
  if (resp.kind === 'error') {
    process.stderr.write(`error: ${resp.message}\n`);
    process.exit(1);
    return;
  }
  process.stderr.write(`error: unexpected response ${resp.kind}\n`);
  process.exit(1);
}

// ---- Flag parser -----------------------------------------------------------
//
// Hand-rolled because the surface is small (3 known flags + positionals) and
// pulling in commander/yargs would balloon the bundle for one CLI. Supports:
//   --key value     long form with separate value
//   --key=value     long form with inline value
//   --key           boolean flag (also -y / --yes / -h / --help)
//   <positional>    everything else, in order

interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-y' || a === '--yes') { flags.yes = true; continue; }
    if (a === '-h' || a === '--help') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

function basenameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

async function readLineFromStdin(): Promise<string> {
  return new Promise<string>((resolveStr) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        process.stdin.removeListener('data', onData);
        resolveStr(buf.slice(0, nl).trim());
      }
    };
    process.stdin.on('data', onData);
  });
}

if (process.argv[1]?.endsWith('tlive-workspace.mjs')) {
  await workspaceCommand(process.argv.slice(2));
}
