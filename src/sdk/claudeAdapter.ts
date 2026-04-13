// src/sdk/claudeAdapter.ts

import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ProviderAdapter,
  ProviderCapabilityFlags,
  NormalizedMessage,
  SpawnOptions,
  RemoteOptions,
} from './providerAdapter.js';
import { findLastSession } from '../core/sessionDiscovery.js';

export class ClaudeAdapter implements ProviderAdapter {
  name = 'claude' as const;
  capabilities: ProviderCapabilityFlags = { liveSession: true };
  private executablePath: string | null = null;

  async resolveExecutable(): Promise<string> {
    if (this.executablePath) return this.executablePath;
    if (process.env.CTI_CLAUDE_CODE_EXECUTABLE) {
      this.executablePath = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
      return this.executablePath;
    }
    try {
      this.executablePath = execSync('which claude', {
        encoding: 'utf-8',
      }).trim();
    } catch {
      this.executablePath = 'claude';
    }
    return this.executablePath;
  }

  getSessionIdArgs(sessionId: string): string[] {
    return ['--session-id', sessionId];
  }

  getResumeArgs(sessionId: string): string[] {
    return ['--resume', '--session-id', sessionId];
  }

  spawnArgs(opts: SpawnOptions): string[] {
    const args = [...this.getSessionIdArgs(opts.sessionId)];
    if (opts.args) args.push(...opts.args);
    return args;
  }

  async *startRemote(
    _opts: RemoteOptions,
  ): AsyncIterable<NormalizedMessage> {
    // SDK integration will be wired in later when we have the real SDK dependency.
    // For now this is the interface contract.
    throw new Error(
      'startRemote requires Claude Agent SDK — wire in integration task',
    );
  }

  getSessionDir(workdir: string): string {
    const projectDir = resolve(workdir).replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectDir);
  }

  findLastSession(workdir: string): string | null {
    return findLastSession(workdir);
  }
}
