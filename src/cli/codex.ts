// src/cli/codex.ts
// `tlive codex` entry point — wraps Codex CLI with web terminal + IM bridge.

import { CodexAdapter } from '../sdk/codexAdapter.js';
import { CodexSessionScanner } from '../core/codexSessionScanner.js';
import { runFlavor } from './runFlavor.js';

export interface CodexCommandOptions {
  sessionId?: string;
  resume?: boolean;
  workdir?: string;
  worktree?: boolean | string;
}

export async function codexCommand(opts: CodexCommandOptions = {}): Promise<void> {
  await runFlavor({
    adapter: new CodexAdapter(),
    runtimeLabel: 'Codex',
    scannerFactory: ({ sessionDir }) =>
      new CodexSessionScanner({ sessionDir }),
    ...opts,
  });
}
