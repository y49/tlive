// src/runtime/codex-app-server/approval-bridge.ts
//
// Bridges codex-app-server's server-initiated approval requests to the
// session-level PermissionBroker via a PermissionRequest emitter. Unlike
// the bridge/ copy (which calls a bridge-level onPermissionRequest handler
// directly), this variant emits a PermissionRequest and awaits resolution
// through the shared types.

import type { PermissionRequest, PermissionDecision } from '../types.js';

export interface CodexApprovalBridgeDeps {
  sessionId: string;
  emit: (req: PermissionRequest) => void;
}

export class CodexApprovalBridge {
  constructor(private readonly deps: CodexApprovalBridgeDeps) {}

  async handleCommandExecutionApproval(
    toolUseId: string,
    command: string[],
    cwd: string,
  ): Promise<'approved' | 'approved_for_session' | 'denied' | 'abort'> {
    const decision = await this.ask(toolUseId, 'exec', { command, cwd });
    return this.toCodex(decision);
  }

  async handleFileChangeApproval(
    toolUseId: string,
    path: string,
    changes: Array<{ kind: 'add' | 'delete' | 'update' }>,
  ): Promise<'approved' | 'approved_for_session' | 'denied' | 'abort'> {
    const decision = await this.ask(toolUseId, 'file', { path, changes });
    return this.toCodex(decision);
  }

  private ask(
    toolUseId: string,
    kind: 'exec' | 'file',
    toolInput: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolveDecision) => {
      const id = `${this.deps.sessionId}:${toolUseId}`;
      const toolName = kind === 'exec' ? 'Bash' : 'Edit';
      this.deps.emit({ id, toolName, toolInput, resolve: resolveDecision });
    });
  }

  private toCodex(d: PermissionDecision): 'approved' | 'approved_for_session' | 'denied' {
    return d === 'allow' ? 'approved' : d === 'allow_always' ? 'approved_for_session' : 'denied';
  }
}
