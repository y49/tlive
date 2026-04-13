// src/sdk/codexAdapter.ts

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ProviderAdapter,
  ProviderCapabilityFlags,
  NormalizedMessage,
  SpawnOptions,
  RemoteOptions,
} from './providerAdapter.js';

export class CodexAdapter implements ProviderAdapter {
  name = 'codex' as const;
  capabilities: ProviderCapabilityFlags = { liveSession: false };
  private executablePath: string | null = null;

  async resolveExecutable(): Promise<string> {
    if (this.executablePath) return this.executablePath;
    if (process.env.TLIVE_CODEX_EXECUTABLE) {
      this.executablePath = process.env.TLIVE_CODEX_EXECUTABLE;
      return this.executablePath;
    }
    try {
      this.executablePath = execSync('which codex', {
        encoding: 'utf-8',
      }).trim();
    } catch {
      this.executablePath = 'codex';
    }
    return this.executablePath;
  }

  getSessionIdArgs(_sessionId: string): string[] {
    // Codex CLI assigns its own session id; we detect it via scanner.
    return [];
  }

  getResumeArgs(sessionId: string): string[] {
    return ['--resume', sessionId];
  }

  spawnArgs(opts: SpawnOptions): string[] {
    return opts.args ? [...opts.args] : [];
  }

  async *startRemote(
    _opts: RemoteOptions,
  ): AsyncIterable<NormalizedMessage> {
    throw new Error('Codex remote SDK path not implemented in terminal mode');
  }

  getSessionDir(_workdir: string): string {
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    return join(codexHome, 'sessions');
  }
}
