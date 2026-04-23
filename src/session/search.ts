// src/session/search.ts
//
// Substring search across discovered session jsonl files. IM `/search <q>`
// calls this; caller supplies the SessionListing[] (from discovery.ts) and a
// loader for the raw jsonl messages. Keeping I/O injected makes this unit-
// testable without real files.

import { promises as fs } from 'node:fs';
import type { SessionListing } from './discovery.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SearchHit {
  sdkSessionId: string;
  provider: SessionListing['provider'];
  workdir: string;
  title?: string;
  /** Snippet of text around the match — ~120 chars context window. */
  snippet: string;
  /** Raw timestamp (ms) of the matching message — for sort. */
  matchedAt: number;
}

export interface SearchOptions {
  /** Case-insensitive substring search. */
  query: string;
  /** Workspace workdir filter. */
  workdir?: string;
  /** Max hits to return (default 20). */
  limit?: number;
  /** Custom loader for jsonl file paths — tests. */
  resolvePath?: (listing: SessionListing) => string | null;
  /** Custom readFile — tests. */
  readFile?: (path: string) => Promise<string>;
}

export async function searchSessions(
  listings: readonly SessionListing[],
  opts: SearchOptions,
): Promise<SearchHit[]> {
  if (!opts.query) return [];
  const needle = opts.query.toLowerCase();
  const limit = opts.limit ?? 20;
  const resolvePath = opts.resolvePath ?? defaultResolvePath;
  const readFile = opts.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));

  const hits: SearchHit[] = [];
  for (const listing of listings) {
    if (opts.workdir && listing.workdir !== opts.workdir) continue;
    const path = resolvePath(listing);
    if (!path) continue;
    let raw: string;
    try { raw = await readFile(path); }
    catch { continue; }
    let matched = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const lower = line.toLowerCase();
      const idx = lower.indexOf(needle);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 40);
      const end = Math.min(line.length, idx + needle.length + 80);
      const snippet = line.slice(start, end);
      hits.push({
        sdkSessionId: listing.sdkSessionId,
        provider: listing.provider,
        workdir: listing.workdir,
        title: listing.title,
        snippet,
        matchedAt: listing.lastActivityAt.getTime(),
      });
      matched++;
      if (matched >= 3) break;   // cap per-session hits so one chatty session doesn't crowd out
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  hits.sort((a, b) => b.matchedAt - a.matchedAt);
  return hits;
}

function defaultResolvePath(listing: SessionListing): string | null {
  const home = homedir();
  if (listing.provider === 'claude') {
    // Derive slug: workdir → "-home-user-foo"
    const slug = listing.workdir.replace(/^\//, '-').replace(/\//g, '-');
    return join(home, '.claude', 'projects', slug, `${listing.sdkSessionId}.jsonl`);
  }
  if (listing.provider === 'codex') {
    return join(home, '.codex', 'sessions', `${listing.sdkSessionId}.jsonl`);
  }
  return null;
}
