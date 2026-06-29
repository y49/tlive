// src/cli/subcommands/hook.ts
//
// Thin shim invoked by Claude's hook system.
// Reads hook JSON from stdin, forwards to daemon via IPC, writes decision to stdout.
//
// Security default: if daemon is unreachable or no binding exists (defer),
// output {} and exit 0 → Claude falls back to local TUI permission prompt.

import { request } from '../../kernel/ipc/client.js';
import {
  parseHookInput,
  permissionDecisionOut,
  continueDecisionOut,
  type HookEventName,
} from '../../kernel/hook/normalizer.js';

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf-8').trim();
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

export async function runHook(argv: string[]): Promise<void> {
  const event = argv[0] as HookEventName | undefined;
  if (!event) {
    process.stderr.write('Usage: tlive hook <pre-tool-use|post-tool-use|stop|notification>\n');
    process.exit(1);
  }

  const raw = await readStdin();
  const n = parseHookInput(event, raw);

  try {
    if (n.event === 'approval-request') {
      const r = await request(
        {
          kind: 'hook.permission.request',
          cwd: n.cwd,
          sessionId: n.sessionId,
          toolName: n.toolName,
          input: n.input,
        },
        { timeoutMs: 300_000 },
      );
      const decision = r.kind === 'hook.permission.result' ? r.decision : 'defer';
      process.stdout.write(JSON.stringify(permissionDecisionOut(decision)));
      return;
    }

    if (event === 'stop') {
      const r = await request(
        {
          kind: 'hook.continue.request',
          cwd: n.cwd,
          sessionId: n.sessionId,
          context: (n as { message: string }).message,
        },
        { timeoutMs: 180_000 },
      );
      const reply = r.kind === 'hook.continue.result' ? r.reply : null;
      process.stdout.write(JSON.stringify(continueDecisionOut(reply)));
      return;
    }

    // post-tool-use / notification: fire-and-forget
    const a = n as { event: string; cwd: string; sessionId: string; toolName?: string; message?: string };
    await request(
      {
        kind: 'hook.notify',
        cwd: a.cwd,
        sessionId: a.sessionId,
        level: 'info',
        message: a.message ?? `▸ ${a.toolName ?? event}`,
      },
      { timeoutMs: 4_000 },
    ).catch(() => undefined);
    process.stdout.write('{}');
  } catch {
    // Daemon not running or error → safe default: empty output, Claude uses local TUI.
    process.stdout.write('{}');
  }
}
