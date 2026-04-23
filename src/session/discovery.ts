// src/session/discovery.ts
//
// Unified session-listing across SDK-native discovery (Claude Agent SDK's
// `listSessions`) and filesystem scan (Codex, or Claude fallback when the
// SDK is offline or returns empty). Outputs a single `SessionListing`
// shape the IM `/sessions` command pages through.

import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { AgentProvider } from '../runtime/types.js';

export interface SessionListing {
  sdkSessionId: string;
  provider: AgentProvider;
  workdir: string;
  createdAt: Date;
  lastActivityAt: Date;
  title?: string;
  /** First user prompt — truncated to 80 chars for card rendering. */
  preview: string;
  /** Populated by caller post-merge (from SessionManager.list()). */
  activeInDaemon: boolean;
  archived: boolean;
}

export interface DiscoveryOptions {
  /** Filter to sessions under a specific workdir. */
  workdir?: string;
  /** Providers to include (default both). */
  providers?: AgentProvider[];
  /** Mark these sdkSessionIds as activeInDaemon=true. */
  liveIds?: ReadonlySet<string>;
  /** Custom Claude SDK listSessions fn — mostly used in tests. */
  claudeListSessions?: (opts: { dir?: string }) => Promise<Array<{
    sessionId: string;
    summary?: string;
    lastModified?: number;
    createdAt?: number;
    cwd?: string;
    customTitle?: string;
    firstPrompt?: string;
  }>>;
  /** Override home dir — tests. */
  home?: string;
}

/** Find all sessions across providers. */
export async function discoverSessions(opts: DiscoveryOptions = {}): Promise<SessionListing[]> {
  const providers = opts.providers ?? ['claude', 'codex'];
  const home = opts.home ?? homedir();
  const live = opts.liveIds ?? new Set<string>();

  const results: SessionListing[] = [];

  if (providers.includes('claude')) {
    const claude = await discoverClaude(opts, home, live);
    results.push(...claude);
  }
  if (providers.includes('codex')) {
    const codex = await discoverCodex(opts, home, live);
    results.push(...codex);
  }

  // Dedupe by sdkSessionId (SDK-first wins)
  const seen = new Set<string>();
  const deduped: SessionListing[] = [];
  for (const r of results) {
    if (seen.has(r.sdkSessionId)) continue;
    seen.add(r.sdkSessionId);
    deduped.push(r);
  }
  deduped.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  return deduped;
}

// ---- Claude --------------------------------------------------------------

async function discoverClaude(
  opts: DiscoveryOptions,
  home: string,
  live: ReadonlySet<string>,
): Promise<SessionListing[]> {
  // Try SDK-native first.
  const sdkFn = opts.claudeListSessions ?? (await loadSdkListSessions());
  if (sdkFn) {
    try {
      const sdkResults = await sdkFn({ dir: opts.workdir });
      return sdkResults.map((s) => ({
        sdkSessionId: s.sessionId,
        provider: 'claude' as const,
        workdir: s.cwd ?? opts.workdir ?? '',
        createdAt: new Date(s.createdAt ?? s.lastModified ?? Date.now()),
        lastActivityAt: new Date(s.lastModified ?? Date.now()),
        title: s.customTitle,
        preview: truncate(s.firstPrompt ?? s.summary ?? '', 80),
        activeInDaemon: live.has(s.sessionId),
        archived: false,
      }));
    } catch {
      // Fall through to filesystem
    }
  }
  return scanClaudeFilesystem(opts, home, live);
}

async function loadSdkListSessions(): Promise<DiscoveryOptions['claudeListSessions'] | null> {
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof (mod as { listSessions?: unknown }).listSessions === 'function') {
      return (mod as { listSessions: NonNullable<DiscoveryOptions['claudeListSessions']> }).listSessions;
    }
  } catch { /* SDK not installed — use filesystem */ }
  return null;
}

async function scanClaudeFilesystem(
  opts: DiscoveryOptions,
  home: string,
  live: ReadonlySet<string>,
): Promise<SessionListing[]> {
  const projects = join(home, '.claude', 'projects');
  let entries: string[];
  try { entries = await fs.readdir(projects); }
  catch { return []; }

  const results: SessionListing[] = [];
  for (const slug of entries) {
    const dir = join(projects, slug);
    let files: string[];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const fname of files) {
      if (!fname.endsWith('.jsonl')) continue;
      const sessionId = fname.slice(0, -'.jsonl'.length);
      const path = join(dir, fname);
      try {
        const stat = await fs.stat(path);
        const preview = await readFirstUserLine(path);
        // Try to recover workdir from slug (".claude/projects/-home-x-foo" → "/home/x/foo")
        const inferredWorkdir = slugToWorkdir(slug);
        if (opts.workdir && opts.workdir !== inferredWorkdir) continue;
        results.push({
          sdkSessionId: sessionId,
          provider: 'claude',
          workdir: inferredWorkdir,
          createdAt: new Date(stat.birthtimeMs || stat.mtimeMs),
          lastActivityAt: new Date(stat.mtimeMs),
          title: undefined,
          preview: truncate(preview, 80),
          activeInDaemon: live.has(sessionId),
          archived: false,
        });
      } catch { /* skip unreadable */ }
    }
  }
  return results;
}

function slugToWorkdir(slug: string): string {
  // Claude stores project dirs as "-home-user-foo" → "/home/user/foo".
  if (!slug.startsWith('-')) return slug;
  return '/' + slug.slice(1).replace(/-/g, '/');
}

// ---- Codex ---------------------------------------------------------------

async function discoverCodex(
  opts: DiscoveryOptions,
  home: string,
  live: ReadonlySet<string>,
): Promise<SessionListing[]> {
  const root = join(home, '.codex', 'sessions');
  const files = await walkJsonl(root).catch(() => []);
  const results: SessionListing[] = [];
  for (const path of files) {
    try {
      const stat = await fs.stat(path);
      const sessionId = basename(path, '.jsonl');
      const preview = await readFirstUserLine(path);
      if (opts.workdir && !preview) {
        /* best-effort — codex sessions don't always carry workdir at line 0 */
      }
      results.push({
        sdkSessionId: sessionId,
        provider: 'codex',
        workdir: opts.workdir ?? '',
        createdAt: new Date(stat.birthtimeMs || stat.mtimeMs),
        lastActivityAt: new Date(stat.mtimeMs),
        title: undefined,
        preview: truncate(preview, 80),
        activeInDaemon: live.has(sessionId),
        archived: false,
      });
    } catch { /* skip unreadable */ }
  }
  return results;
}

async function walkJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) out.push(...await walkJsonl(p));
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ---- Shared --------------------------------------------------------------

async function readFirstUserLine(path: string): Promise<string> {
  try {
    const fh = await fs.open(path, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const text = buf.slice(0, bytesRead).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { role?: string; type?: string; message?: { role?: string; content?: unknown }; content?: unknown };
          const role = rec.role ?? rec.message?.role ?? rec.type;
          if (role === 'user') {
            const content = rec.content ?? rec.message?.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
              const first = content.find((p): p is { text: string } =>
                !!p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string');
              if (first) return first.text;
            }
            return '';
          }
        } catch { /* skip malformed */ }
      }
      return '';
    } finally { await fh.close(); }
  } catch { return ''; }
}

function truncate(s: string, max: number): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + '…';
}
