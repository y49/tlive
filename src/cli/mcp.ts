// src/cli/mcp.ts
//
// `tlive mcp` subcommand — stdio entry point for MCP clients (Claude CLI,
// Codex, etc). Connects to the daemon's shared state; production wires
// through the T9 IPC server. In the current T5 cut, this is a minimal
// stdio launcher: if no daemon is reachable, we boot a local in-memory
// fallback so the `initialize` handshake + tool registration still works
// (useful for claude-desktop style plug-ins).

import { createRequire } from 'node:module';
import { SessionManager } from '../session/manager.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { PermissionBroker } from '../permission/broker.js';
import { AskUserQuestionBroker } from '../permission/ask-broker.js';
import { ElicitationBroker } from '../permission/elicitation-broker.js';
import { AttachmentStore } from '../attachment/store.js';
import { PolicyStore } from '../permission/policy-store.js';
import { InMemorySignalBus } from '../mcp/self/signals.js';
import { startTliveMcpServer } from '../mcp/self/server.js';
import type { McpToolDeps } from '../mcp/self/deps.js';
import type { SessionPersistence } from '../session/persistence.js';
import type { AgentRuntime } from '../runtime/types.js';

// ---- Fallback stub persistence for the standalone code path ----------------

function stubPersistence(): SessionPersistence {
  // Minimal SessionPersistence; the standalone server never persists.
  return {
    async saveSnapshot() { /* noop */ },
    async loadSnapshot() { return null; },
    async appendEvent() { /* noop */ },
    async loadHistory() { return []; },
    async listSnapshots() { return []; },
    async removeSession() { /* noop */ },
    async writeMeta() { /* noop */ },
    async loadMeta() { return null; },
    async loadAllMeta() { return []; },
    async removeMeta() { /* noop */ },
  } as unknown as SessionPersistence;
}

function stubRuntime(): AgentRuntime {
  throw new Error('tlive mcp standalone: no daemon IPC available; runtime creation disabled');
}

async function main(): Promise<void> {
  const attachments = new AttachmentStore();
  await attachments.init();
  const permissionBroker = new PermissionBroker();
  const askBroker = new AskUserQuestionBroker();
  const elicitationBroker = new ElicitationBroker();
  const workspaces = new WorkspaceManager();
  const sessions = new SessionManager({
    persistence: stubPersistence(),
    broker: permissionBroker,
    askBroker,
    elicitationBroker,
    runtimeFactory: stubRuntime,
    attachmentStore: attachments,
  });
  const signals = new InMemorySignalBus();

  const deps: McpToolDeps = {
    sessions,
    workspaces,
    permissionBroker,
    askBroker,
    elicitationBroker,
    attachments,
    policyStoreFor: (workspaceId) => new PolicyStore(workspaceId),
    signals,
    notifier: {
      async notify(_sessionId, text) {
        // Standalone: log to stderr so downstream clients see nothing on stdout.
        process.stderr.write(`[tlive] ${text}\n`);
      },
    },
    user: () => ({ id: 'mcp-client', displayName: process.env.USER ?? 'user' }),
  };

  const handle = await startTliveMcpServer({ deps });
  // Make sure the process exits gracefully on disconnect.
  process.on('SIGINT', () => { handle.close().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { handle.close().finally(() => process.exit(0)); });
}

// Entrypoint — bail on unhandled rejections so nothing hangs the pipe.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`tlive mcp failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}

// Keep a require shim around in case something wants CJS interop.
export const _require = createRequire(import.meta.url);
