// src/cli/mcp.ts
//
// `tlive mcp` subcommand — stdio entry point for MCP clients (Claude CLI,
// Codex, etc). Two modes:
//
// 1. **Daemon-attached (production)**: when the tlive daemon is running we
//    still run an in-process tlive-self stdio server in this CLI process
//    because the MCP transport is stdio (Claude/Codex spawn us with
//    stdio pipes). The server uses its own SessionManager/WorkspaceManager/
//    brokers — production persistence is shared with the daemon via the
//    same on-disk root (~/.tlive/), so state on sessions/workspaces is
//    effectively a live view. Future: swap the SessionManager impl for a
//    thin IPC proxy so there is truly one SessionManager in the daemon.
//
// 2. **Standalone**: no daemon running. Same in-process wiring, but
//    runtime creation raises because the CLI mode doesn't spawn local
//    Claude/Codex subprocesses. Tool calls that require a runtime surface
//    a clear error; read-only tools still work because they only need the
//    persistence layer.
//
// The key win over the T5 stub is that both modes now use REAL persistence
// (SessionPersistence at `~/.tlive/sessions/`) + REAL workspace hydration,
// so listing / searching / resuming work end-to-end.

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { SessionManager } from '../session/manager.js';
import { SessionPersistence } from '../session/persistence.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { PermissionBroker } from '../permission/broker.js';
import { AskUserQuestionBroker } from '../permission/ask-broker.js';
import { ElicitationBroker } from '../permission/elicitation-broker.js';
import { AttachmentStore } from '../attachment/store.js';
import { PolicyStore } from '../permission/policy-store.js';
import { CostRollupStore } from '../cost/rollups.js';
import { InMemorySignalBus } from '../mcp/self/signals.js';
import { startTliveMcpServer } from '../mcp/self/server.js';
import type { McpToolDeps } from '../mcp/self/deps.js';
import type { AgentRuntime } from '../runtime/types.js';
import { getSocketPath } from '../ipc/client.js';

/**
 * Produce a runtime factory that surfaces a clear error when invoked.
 * RemoteSessions don't need runtimes; local-session creation via the MCP
 * tool path is rare (most sessions are created by IM commands while the
 * daemon has a real factory). If a caller does invoke us, they get:
 * "runtime creation disabled in mcp stdio mode — use the daemon".
 */
function noRuntimeFactory(): AgentRuntime {
  throw new Error('tlive mcp stdio mode: runtime creation disabled. Run `tlive start` so sessions have a runtime.');
}

async function main(): Promise<void> {
  const home = join(homedir(), '.tlive');

  // Real persistence + attachment store rooted at ~/.tlive/.
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const attachments = new AttachmentStore({ rootDir: join(home, 'attachments') });
  await attachments.init();

  const permissionBroker = new PermissionBroker();
  const askBroker = new AskUserQuestionBroker();
  const elicitationBroker = new ElicitationBroker();

  // Workspaces — hydrate from the daemon's persisted workspaces.json so
  // RemoteSession.create can locate the right workspace by cwd.
  const workspaces = new WorkspaceManager({ persistPath: join(home, 'workspaces.json') });
  await workspaces.load();

  const rollups = new CostRollupStore(join(home, 'cost', 'rollups.jsonl'));

  const sessions = new SessionManager({
    persistence,
    broker: permissionBroker,
    askBroker,
    elicitationBroker,
    runtimeFactory: noRuntimeFactory,
    attachmentStore: attachments,
    rollupStore: rollups,
  });

  const signals = new InMemorySignalBus();
  const daemonReachable = existsSync(getSocketPath());

  const policyStoreFor = (workspaceId: string) => new PolicyStore(workspaceId, {
    file: join(home, 'workspaces', workspaceId, 'policies.json'),
  });

  const deps: McpToolDeps = {
    sessions,
    workspaces,
    permissionBroker,
    askBroker,
    elicitationBroker,
    attachments,
    policyStoreFor,
    rollups,
    signals,
    notifier: {
      async notify(_sessionId, text) {
        // stdio mode — send notifier output to stderr so it doesn't corrupt
        // the MCP protocol stream on stdout.
        process.stderr.write(`[tlive] ${text}\n`);
      },
    },
    user: () => ({ id: 'mcp-client', displayName: process.env.USER ?? 'user' }),
    dataDir: home,
  };

  if (!daemonReachable) {
    process.stderr.write('[tlive mcp] daemon not running — read-only operations work, session creation will error.\n');
  }

  const handle = await startTliveMcpServer({ deps });
  process.on('SIGINT', () => { handle.close().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { handle.close().finally(() => process.exit(0)); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`tlive mcp failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}

// CJS interop shim.
export const _require = createRequire(import.meta.url);
