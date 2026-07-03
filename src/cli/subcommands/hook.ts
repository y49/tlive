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
  type MonitorEvent,
} from '../../kernel/hook/normalizer.js';

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf-8').trim();
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

const USAGE = 'Usage: tlive hook <pre-tool-use|post-tool-use|stop|notification|user-prompt-submit|session-start|session-end>\n';

export async function runHook(argv: string[]): Promise<void> {
  const event = argv[0] as HookEventName | undefined;
  if (!event) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const raw = await readStdin();
  const n = parseHookInput(event, raw);
  // Inherited from a `tlive run` pty (like $TMUX): routes this hook's traffic
  // to that exact session card, so several wrapped sessions can share one cwd.
  const wrappedId = process.env.TLIVE_SESSION;

  try {
    if (n.event === 'approval-request') {
      const r = await request(
        {
          kind: 'hook.permission.request',
          cwd: n.cwd,
          sessionId: n.sessionId,
          toolName: n.toolName,
          input: n.input,
          permissionMode: n.permissionMode,
          ...(wrappedId ? { wrappedId } : {}),
        },
        { timeoutMs: 590_000 },
      );
      const decision = r.kind === 'hook.permission.result' ? r.decision : 'defer';
      process.stdout.write(JSON.stringify(permissionDecisionOut(decision)));
      return;
    }

    if (event === 'stop') {
      const att = n as { cwd: string; sessionId: string; message: string; lastMessage?: string };
      const r = await request(
        {
          kind: 'hook.continue.request',
          cwd: att.cwd,
          sessionId: att.sessionId,
          context: att.message,
          ...(att.lastMessage ? { lastMessage: att.lastMessage } : {}),
          ...(wrappedId ? { wrappedId } : {}),
        },
        { timeoutMs: 175_000 },
      );
      const reply = r.kind === 'hook.continue.result' ? r.reply : null;
      process.stdout.write(JSON.stringify(continueDecisionOut(reply)));
      return;
    }

    if (event === 'notification') {
      const att = n as { cwd: string; sessionId: string; message: string };
      await request(
        { kind: 'hook.notify', cwd: att.cwd, sessionId: att.sessionId, level: 'info', message: att.message, ...(wrappedId ? { wrappedId } : {}) },
        { timeoutMs: 4_000 },
      ).catch(() => undefined);
      process.stdout.write('{}');
      return;
    }

    // post-tool-use / user-prompt-submit / session-start / session-end → monitoring
    await request(
      { kind: 'hook.event', event: n as MonitorEvent, ...(wrappedId ? { wrappedId } : {}) },
      { timeoutMs: 4_000 },
    ).catch(() => undefined);
    process.stdout.write('{}');
  } catch {
    // Daemon not running or error → safe default: empty output, Claude uses local TUI.
    process.stdout.write('{}');
  }
}
