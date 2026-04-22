// src/runtime/codex-app-server/approval-bridge.ts
//
// Bridges codex-app-server's server-initiated approval requests to the
// session-level PermissionBroker via a PermissionRequest emitter. Unlike
// the bridge/ copy (which calls a bridge-level onPermissionRequest handler
// directly), this variant emits a PermissionRequest and awaits resolution
// through the shared types.

import { randomBytes } from 'node:crypto';
import type { PermissionRequest, PermissionDecision } from '../types.js';

export interface CodexApprovalBridgeDeps {
  sessionId: string;
  emit: (req: PermissionRequest) => void;
}

export class CodexApprovalBridge {
  constructor(private readonly deps: CodexApprovalBridgeDeps) {}

  async handleCommandExecutionApproval(
    _toolUseId: string,
    command: string[],
    cwd: string,
  ): Promise<'approved' | 'approved_for_session' | 'denied' | 'abort'> {
    const decision = await this.ask('exec', { command, cwd });
    return this.toCodex(decision);
  }

  async handleFileChangeApproval(
    _toolUseId: string,
    path: string,
    changes: Array<{ kind: 'add' | 'delete' | 'update' }>,
  ): Promise<'approved' | 'approved_for_session' | 'denied' | 'abort'> {
    const decision = await this.ask('file', { path, changes });
    return this.toCodex(decision);
  }

  private ask(
    kind: 'exec' | 'file',
    toolInput: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolveDecision) => {
      // Short local id (8 hex chars) keeps `${sessionId}:${shortId}` under
      // Telegram's 53-byte callback_data limit after renderers prepend
      // `perm:allow:` / `perm:deny:`. The incoming codex toolUseId is
      // discarded — nothing downstream correlates on it today.
      const shortId = randomBytes(4).toString('hex');
      const id = `${this.deps.sessionId}:${shortId}`;
      const toolName = kind === 'exec' ? 'Bash' : 'Edit';
      this.deps.emit({ id, toolName, toolInput, resolve: resolveDecision });
    });
  }

  private toCodex(d: PermissionDecision): 'approved' | 'approved_for_session' | 'denied' {
    return d === 'allow' ? 'approved' : d === 'allow_always' ? 'approved_for_session' : 'denied';
  }
}
