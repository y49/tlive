// bridge/src/engine/session-discovery.ts
//
// Background scanner for all Claude sessions across ~/.claude/projects/.
// Detects sessions not managed by `tlive claude` (plain `claude` sessions)
// and surfaces them for IM resume.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DiscoveredSession {
  sessionId: string;
  projectDir: string;    // e.g., '-home-y-Project-test-myapp'
  projectName: string;   // e.g., 'myapp' (last meaningful segment)
  workdir: string;       // reconstructed: /home/y/Project/test/myapp
  mtime: number;
  lastType: string;      // 'assistant' | 'user' | ''
  isWaiting: boolean;    // true if last message is 'assistant' (Claude waiting for input)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reconstruct workdir from Claude's encoded project directory name.
 * '-home-y-Project-test-myapp' → '/home/y/Project/test/myapp'
 *
 * Claude encodes: resolve(path).replace(/[^a-zA-Z0-9-]/g, '-')
 * This is lossy — we can't perfectly reverse it, but on Linux/Mac
 * the leading '-' maps to '/' and internal '-' are path separators.
 */
export function decodeProjectDir(encoded: string): string {
  if (encoded.startsWith('-')) {
    return encoded.replace(/-/g, '/');
  }
  // Windows: C--Users-bob → C:/Users/bob (approximate)
  return encoded.replace(/--/g, ':/').replace(/-/g, '/');
}

/**
 * Extract project name (last meaningful path segment) from encoded project dir.
 */
export function extractProjectName(projectDir: string): string {
  const decoded = decodeProjectDir(projectDir);
  const parts = decoded.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : projectDir;
}

/**
 * Scan for recently active Claude sessions across all projects.
 * Returns sessions modified within `recencyMs` (default: 10 minutes),
 * sorted by most recently modified first.
 */
export function discoverActiveSessions(recencyMs = 10 * 60 * 1000): DiscoveredSession[] {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const projectsDir = join(claudeConfigDir, 'projects');
  if (!existsSync(projectsDir)) return [];

  const now = Date.now();
  const results: DiscoveredSession[] = [];

  try {
    for (const projectDir of readdirSync(projectsDir)) {
      const fullProjectDir = join(projectsDir, projectDir);
      let stat;
      try { stat = statSync(fullProjectDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      try {
        for (const file of readdirSync(fullProjectDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = file.replace('.jsonl', '');
          if (!UUID_PATTERN.test(sessionId)) continue;

          const filePath = join(fullProjectDir, file);
          let fileStat;
          try { fileStat = statSync(filePath); } catch { continue; }

          // Only sessions active within recency window
          if (now - fileStat.mtime.getTime() > recencyMs) continue;

          // Quick peek at last message type
          let lastType = '';
          let isWaiting = false;
          try {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.trim().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const msg = JSON.parse(lines[i]);
                if (msg.type === 'assistant' || msg.type === 'user') {
                  lastType = msg.type;
                  isWaiting = msg.type === 'assistant';
                  break;
                }
              } catch { continue; }
            }
          } catch { /* unreadable */ }

          results.push({
            sessionId,
            projectDir,
            projectName: extractProjectName(projectDir),
            workdir: decodeProjectDir(projectDir),
            mtime: fileStat.mtime.getTime(),
            lastType,
            isWaiting,
          });
        }
      } catch { /* can't read project dir */ }
    }
  } catch { /* can't read projects dir */ }

  return results.sort((a, b) => b.mtime - a.mtime);
}
