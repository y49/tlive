// src/core/scannerContext.ts
// Readonly session context shared between loop, adapters, and the bridge.
// Constructed once in runFlavor and passed by snapshot over IPC.

export interface ScannerContextSnapshot {
  sessionId: string;
  workdir: string;
  workspaceName: string;  // last non-empty segment of workdir
  provider: 'claude' | 'codex';
  terminalUrl: string;    // full web-terminal URL with token
  isLocal: true;          // all scanner path is local; kept for future remote support
}

export class ScannerContext {
  constructor(readonly snapshot: ScannerContextSnapshot) {}

  static fromWorkdir(opts: {
    sessionId: string;
    workdir: string;
    provider: 'claude' | 'codex';
    terminalUrl: string;
  }): ScannerContext {
    const parts = opts.workdir.split('/').filter(Boolean);
    const workspaceName = parts.length > 0 ? parts[parts.length - 1] : 'unknown';
    return new ScannerContext({
      sessionId: opts.sessionId,
      workdir: opts.workdir,
      workspaceName,
      provider: opts.provider,
      terminalUrl: opts.terminalUrl,
      isLocal: true,
    });
  }
}
