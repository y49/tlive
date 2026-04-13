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
  ThinkingTriggerEvent,
} from './providerAdapter.js';
import { findLastSession } from '../core/sessionDiscovery.js';

/**
 * Extract content blocks from a Claude .jsonl message.
 * Claude format: { message: { role: "assistant", content: [...] } } or flat [...].
 */
function getContentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(message)) return message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) return content;
  }
  return [];
}

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

  /**
   * Map a Claude scanner event (`{ type, message, ... }`) into neutral
   * thinking-tracker triggers. Behavior-equivalent to the former inline
   * block-walking logic in SessionManager.
   */
  extractThinkingEvents(event: unknown): ThinkingTriggerEvent[] {
    const e = event as { type?: string; message?: unknown };
    const blocks = getContentBlocks(e.message);
    const out: ThinkingTriggerEvent[] = [];
    if (e.type === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.id) {
          out.push({ type: 'tool_use', toolUseId: block.id as string });
        } else if (block.type === 'text') {
          out.push({ type: 'text' });
        }
      }
    } else if (e.type === 'user') {
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          out.push({ type: 'tool_result', toolUseId: block.tool_use_id as string });
        }
      }
    }
    return out;
  }
}
