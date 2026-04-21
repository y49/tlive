// src/session/context.ts
//
// Readonly per-session context carried alongside every event/permission.
// Slimmer than the legacy ScannerContext: no terminalUrl (no web terminal),
// no isLocal (always local). Adds workspaceId + createdAt.

export interface SessionContextSnapshot {
  sessionId: string;
  workdir: string;
  /** Opaque workspace id from bridge WorkspaceManager. */
  workspaceId: string;
  /** Display name — last non-empty segment of workdir unless overridden. */
  workspaceName: string;
  provider: 'claude' | 'codex';
  /** Epoch ms when the Session was created. Stable across resume. */
  createdAt: number;
}

export class SessionContext {
  constructor(readonly snapshot: SessionContextSnapshot) {}

  static create(opts: {
    sessionId: string;
    workdir: string;
    workspaceId: string;
    workspaceName?: string;
    provider: 'claude' | 'codex';
    createdAt?: number;
  }): SessionContext {
    const workspaceName = opts.workspaceName
      ?? deriveWorkspaceName(opts.workdir);
    return new SessionContext({
      sessionId: opts.sessionId,
      workdir: opts.workdir,
      workspaceId: opts.workspaceId,
      workspaceName,
      provider: opts.provider,
      createdAt: opts.createdAt ?? Date.now(),
    });
  }
}

function deriveWorkspaceName(workdir: string): string {
  const parts = workdir.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}
