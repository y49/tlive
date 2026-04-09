// src/core/sessionDiscovery.ts
// Adapted from happy's claudeFindLastSession.ts
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get the Claude project path for a working directory.
 * Matches Claude's internal encoding: resolve() then replace non-alphanumeric with '-'.
 */
export function getProjectPath(workingDirectory: string): string {
  const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeConfigDir, 'projects', projectId);
}

/**
 * Check if a session file contains at least one valid message with a uuid field.
 */
function isValidSession(projectDir: string, sessionId: string): boolean {
  try {
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.uuid && (msg.type === 'user' || msg.type === 'assistant')) {
          return true;
        }
      } catch { continue; }
    }
  } catch { /* file not found or unreadable */ }
  return false;
}

// ---------------------------------------------------------------------------
// Session listing with metadata
// ---------------------------------------------------------------------------

export interface SessionMeta {
  sessionId: string;
  mtime: number;
  size: number;
  messageCount: number;
  lastType: string;
}

/**
 * List sessions for a working directory, sorted by most recent first.
 * Returns lightweight metadata (line count, last message type) for each session.
 */
export function listSessions(workingDirectory: string, limit = 10): SessionMeta[] {
  try {
    const projectDir = getProjectPath(workingDirectory);
    return readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const sessionId = f.replace('.jsonl', '');
        if (!UUID_PATTERN.test(sessionId)) return null;
        const filePath = join(projectDir, f);
        const stat = statSync(filePath);
        // Quick peek: count lines and get last message type
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        let lastType = '';
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const msg = JSON.parse(lines[i]);
            if (msg.type === 'assistant' || msg.type === 'user') {
              lastType = msg.type;
              break;
            }
          } catch { continue; }
        }
        return { sessionId, mtime: stat.mtime.getTime(), size: stat.size, messageCount: lines.length, lastType };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch { return []; }
}

/**
 * Find the most recently modified valid session in the project directory.
 * Only accepts UUID-format session IDs (required for --resume in Claude v2.0.65+).
 * Returns the session ID or null if none found.
 */
export function findLastSession(workingDirectory: string): string | null {
  try {
    const projectDir = getProjectPath(workingDirectory);
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const sessionId = f.replace('.jsonl', '');
        if (!UUID_PATTERN.test(sessionId)) return null;
        if (!isValidSession(projectDir, sessionId)) return null;
        return {
          sessionId,
          mtime: statSync(join(projectDir, f)).mtime.getTime(),
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].sessionId : null;
  } catch {
    return null;
  }
}
