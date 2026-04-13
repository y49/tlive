// src/cli/claude.ts
// Thin delegator — actual runner lives in runFlavor.ts.
// Keeps the `claudeCommand` / `setupQR` export shape for backward compatibility.

import { ClaudeAdapter } from '../sdk/claudeAdapter.js';
import { SessionScanner } from '../core/sessionScanner.js';
import { runFlavor, setupQR } from './runFlavor.js';

export { setupQR };

export interface ClaudeCommandOptions {
  resume?: boolean;
  sessionId?: string;
  workdir?: string;
  worktree?: boolean | string;
}

export async function claudeCommand(opts: ClaudeCommandOptions = {}): Promise<void> {
  await runFlavor({
    adapter: new ClaudeAdapter(),
    runtimeLabel: 'Claude',
    scannerFactory: ({ sessionId, workdir, sessionDir, proactiveNotifyDelay, proactiveQuestionDelay }) =>
      new SessionScanner({ sessionId, workdir, sessionDir, proactiveNotifyDelay, proactiveQuestionDelay }),
    ...opts,
  });
}
