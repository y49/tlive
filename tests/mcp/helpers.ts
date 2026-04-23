// tests/mcp/helpers.ts
//
// Shared fixtures for MCP subsystem tests. Keeps deps assembly out of each
// test file.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/manager.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';
import { PermissionBroker } from '../../src/permission/broker.js';
import { AskUserQuestionBroker } from '../../src/permission/ask-broker.js';
import { ElicitationBroker } from '../../src/permission/elicitation-broker.js';
import { AttachmentStore } from '../../src/attachment/store.js';
import { PolicyStore } from '../../src/permission/policy-store.js';
import { SessionPersistence } from '../../src/session/persistence.js';
import { InMemorySignalBus } from '../../src/mcp/self/signals.js';
import { FakeRuntime } from '../session/fake-runtime.js';
import type { McpToolDeps } from '../../src/mcp/self/deps.js';

export interface McpTestHarness {
  root: string;
  deps: McpToolDeps;
  persistence: SessionPersistence;
  signals: InMemorySignalBus;
  notifiedMessages: Array<{ sessionId: string; text: string; opts?: unknown }>;
  runtimes: FakeRuntime[];
}

export async function buildHarness(): Promise<McpTestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'tlive-mcp-'));
  const persistence = new SessionPersistence(root);
  await persistence.init();
  const permissionBroker = new PermissionBroker();
  const askBroker = new AskUserQuestionBroker();
  const elicitationBroker = new ElicitationBroker();
  const workspaces = new WorkspaceManager();
  const attachments = new AttachmentStore({ rootDir: join(root, 'attachments') });
  await attachments.init();
  const runtimes: FakeRuntime[] = [];
  const sessions = new SessionManager({
    persistence,
    broker: permissionBroker,
    askBroker,
    elicitationBroker,
    runtimeFactory: (provider) => {
      const r = new FakeRuntime(provider); runtimes.push(r); return r;
    },
    attachmentStore: attachments,
  });
  const signals = new InMemorySignalBus();
  const notifiedMessages: Array<{ sessionId: string; text: string; opts?: unknown }> = [];

  const deps: McpToolDeps = {
    sessions,
    workspaces,
    permissionBroker,
    askBroker,
    elicitationBroker,
    attachments,
    policyStoreFor: (id) => new PolicyStore(id, { file: join(root, 'workspaces', id, 'policies.json') }),
    signals,
    notifier: {
      async notify(sessionId, text, opts) { notifiedMessages.push({ sessionId, text, opts }); },
    },
    user: () => ({ id: 'test-user', displayName: 'Tester' }),
    dataDir: root,
  };

  return { root, deps, persistence, signals, notifiedMessages, runtimes };
}
