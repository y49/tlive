// src/mcp/self/resources.ts
//
// tlive:// URI namespace.
//
// Forms:
//   tlive://sessions/                              → directory listing
//   tlive://sessions/<alias>/transcript.md         → rendered transcript
//   tlive://sessions/<alias>/meta.json             → SessionInfo JSON
//   tlive://sessions/<alias>/todos.md              → current todos
//   tlive://workspace/<id>/config.json             → workspace config
//   tlive://workspace/<id>/memory/<key>            → memory key JSON
//   tlive://workspace/<id>/summary/today.md        → today's summary
//   tlive://workspace/<id>/summary/YYYY-MM-DD.md   → historical summary
//   tlive://activity/last-24h                      → 24h activity stream
//   tlive://activity/week                          → week activity stream
//
// Subscriptions: `transcript.md` supports live updates via `subscribe`. Each
// session emits NotificationEvents; the resources module keeps a
// subscription map and fans them out to subscribers.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpToolDeps } from './deps.js';
import type { NotificationEvent } from '../../runtime/events.js';

export interface ParsedUri {
  scheme: 'tlive';
  kind: 'sessions_dir' | 'session_transcript' | 'session_meta' | 'session_todos'
      | 'workspace_config' | 'workspace_memory' | 'workspace_summary'
      | 'activity_24h' | 'activity_week';
  alias?: string;
  workspaceId?: string;
  memoryKey?: string;
  summaryDate?: string; // 'today' | 'YYYY-MM-DD'
}

const TLIVE_PREFIX = 'tlive://';

export function parseUri(uri: string): ParsedUri | null {
  if (!uri.startsWith(TLIVE_PREFIX)) return null;
  const rest = uri.slice(TLIVE_PREFIX.length);
  // Normalise trailing slash for directory-like URIs.
  const trimmed = rest.replace(/\/$/, '');

  if (trimmed === 'sessions' || trimmed === 'sessions/') {
    return { scheme: 'tlive', kind: 'sessions_dir' };
  }

  if (trimmed === 'activity/last-24h') return { scheme: 'tlive', kind: 'activity_24h' };
  if (trimmed === 'activity/week') return { scheme: 'tlive', kind: 'activity_week' };

  const sessionM = /^sessions\/([^/]+)\/(transcript\.md|meta\.json|todos\.md)$/.exec(trimmed);
  if (sessionM) {
    const file = sessionM[2]!;
    return {
      scheme: 'tlive',
      kind: file === 'transcript.md' ? 'session_transcript'
        : file === 'meta.json' ? 'session_meta' : 'session_todos',
      alias: sessionM[1]!,
    };
  }

  const wsConfigM = /^workspace\/([^/]+)\/config\.json$/.exec(trimmed);
  if (wsConfigM) return { scheme: 'tlive', kind: 'workspace_config', workspaceId: wsConfigM[1]! };

  const wsMemM = /^workspace\/([^/]+)\/memory\/([^/]+)$/.exec(trimmed);
  if (wsMemM) return { scheme: 'tlive', kind: 'workspace_memory', workspaceId: wsMemM[1]!, memoryKey: wsMemM[2]! };

  const wsSumM = /^workspace\/([^/]+)\/summary\/(today|\d{4}-\d{2}-\d{2})\.md$/.exec(trimmed);
  if (wsSumM) return { scheme: 'tlive', kind: 'workspace_summary', workspaceId: wsSumM[1]!, summaryDate: wsSumM[2]! };

  return null;
}

export interface ResourceDescriptor {
  uri: string;
  name: string;
  mimeType: string;
  description?: string;
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Resource provider: reads and subscribes to tlive:// resources. Backed by
 * SessionManager + WorkspaceManager + the on-disk memory/summary layout.
 */
export class ResourceProvider {
  private readonly subscriptions = new Map<string, Map<string, (ev: NotificationEvent) => void>>();

  constructor(private readonly deps: McpToolDeps) {}

  async list(): Promise<ResourceDescriptor[]> {
    const items: ResourceDescriptor[] = [];
    items.push({ uri: 'tlive://sessions/', name: 'sessions', mimeType: 'application/x-directory' });
    for (const s of this.deps.sessions.listInfo()) {
      items.push({
        uri: `tlive://sessions/${s.shortAlias}/meta.json`,
        name: `${s.shortAlias} meta`,
        mimeType: 'application/json',
      });
      items.push({
        uri: `tlive://sessions/${s.shortAlias}/transcript.md`,
        name: `${s.shortAlias} transcript`,
        mimeType: 'text/markdown',
      });
    }
    for (const ws of this.deps.workspaces.list()) {
      items.push({
        uri: `tlive://workspace/${ws.id}/config.json`,
        name: `${ws.name} config`,
        mimeType: 'application/json',
      });
      items.push({
        uri: `tlive://workspace/${ws.id}/summary/today.md`,
        name: `${ws.name} today summary`,
        mimeType: 'text/markdown',
      });
    }
    items.push({ uri: 'tlive://activity/last-24h', name: 'activity (24h)', mimeType: 'text/markdown' });
    items.push({ uri: 'tlive://activity/week', name: 'activity (week)', mimeType: 'text/markdown' });
    return items;
  }

  async read(uri: string): Promise<ResourceContent | null> {
    const parsed = parseUri(uri);
    if (!parsed) return null;
    switch (parsed.kind) {
      case 'sessions_dir': {
        const items = this.deps.sessions.listInfo();
        const lines = items.map((i) => `- ${i.shortAlias} [${i.status.phase}] ${i.workdir}`);
        return { uri, mimeType: 'text/markdown', text: lines.join('\n') };
      }
      case 'session_meta': {
        const s = this.resolveAlias(parsed.alias!);
        if (!s) return null;
        return { uri, mimeType: 'application/json', text: JSON.stringify(s.snapshot(), null, 2) };
      }
      case 'session_transcript': {
        const s = this.resolveAlias(parsed.alias!);
        if (!s) return null;
        return { uri, mimeType: 'text/markdown', text: `# ${s.shortAlias}\n\n(transcript live updates via subscribe)` };
      }
      case 'session_todos': {
        const s = this.resolveAlias(parsed.alias!);
        if (!s) return null;
        return { uri, mimeType: 'text/markdown', text: `# TODOs — ${s.shortAlias}\n\n(no todos tracked yet)` };
      }
      case 'workspace_config': {
        const ws = this.deps.workspaces.get(parsed.workspaceId!);
        if (!ws) return null;
        return { uri, mimeType: 'application/json', text: JSON.stringify(ws, null, 2) };
      }
      case 'workspace_memory': {
        const path = this.memoryPath(parsed.workspaceId!, parsed.memoryKey!);
        try {
          const text = await fs.readFile(path, 'utf8');
          return { uri, mimeType: 'application/json', text };
        } catch { return null; }
      }
      case 'workspace_summary': {
        const path = this.summaryPath(parsed.workspaceId!, parsed.summaryDate!);
        try {
          const text = await fs.readFile(path, 'utf8');
          return { uri, mimeType: 'text/markdown', text };
        } catch {
          return { uri, mimeType: 'text/markdown', text: `# Summary ${parsed.summaryDate}\n\n(no summary recorded)` };
        }
      }
      case 'activity_24h':
      case 'activity_week': {
        const window = parsed.kind === 'activity_24h' ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
        const since = Date.now() - window;
        const items = this.deps.sessions.listInfo().filter((i) => i.lastActivityAt >= since);
        const lines = items.map((i) => `- ${new Date(i.lastActivityAt).toISOString()} ${i.shortAlias} ${i.title ?? ''}`);
        return { uri, mimeType: 'text/markdown', text: lines.join('\n') };
      }
    }
  }

  /**
   * Subscribe to a tlive://sessions/<alias>/transcript.md URI. Returns an
   * unsubscribe function.
   */
  subscribe(uri: string, cb: (ev: NotificationEvent) => void): (() => void) | null {
    const parsed = parseUri(uri);
    if (!parsed || parsed.kind !== 'session_transcript') return null;
    const s = this.resolveAlias(parsed.alias!);
    if (!s) return null;
    const unsubFromSession = s.onEvent(cb);
    const sub = this.subscriptions.get(uri) ?? new Map<string, (ev: NotificationEvent) => void>();
    const key = `sub-${sub.size + 1}-${Date.now()}`;
    sub.set(key, cb);
    this.subscriptions.set(uri, sub);
    return () => {
      unsubFromSession();
      sub.delete(key);
      if (sub.size === 0) this.subscriptions.delete(uri);
    };
  }

  private resolveAlias(alias: string) {
    const direct = this.deps.sessions.get(alias);
    if (direct) return direct;
    // Accept either `r-<8hex>` (RemoteSession shortAlias) or plain 8hex prefix.
    const stripped = alias.startsWith('r-') ? alias.slice(2) : alias;
    const { resolved } = this.deps.sessions.getByPrefix(stripped);
    return resolved ?? null;
  }

  private memoryPath(workspaceId: string, key: string): string {
    const root = this.deps.dataDir ?? join(homedir(), '.tlive');
    return join(root, 'workspaces', workspaceId, 'memory', `${key}.json`);
  }

  private summaryPath(workspaceId: string, date: string): string {
    const root = this.deps.dataDir ?? join(homedir(), '.tlive');
    const name = date === 'today' ? `${new Date().toISOString().slice(0, 10)}.md` : `${date}.md`;
    return join(root, 'workspaces', workspaceId, 'summary', name);
  }
}
