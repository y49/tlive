// src/kernel/workspace/registry.ts
//
// In-memory workspace list backed by ~/.tlive/config.json.

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface Workspace {
  id: string;
  path: string;
}

interface ConfigShape {
  workspaces?: Record<string, string>;
  chatBindings?: Record<string, string>;
  allowedSenders?: Array<{ channel: string; userId: string }>;
}

export interface WorkspaceRegistryOpts {
  /** Home dir override; default: ~/.tlive */
  home: string;
}

export class WorkspaceRegistry {
  private readonly configPath: string;
  private cfg: ConfigShape;

  constructor(opts: WorkspaceRegistryOpts) {
    mkdirSync(opts.home, { recursive: true });
    this.configPath = join(opts.home, 'config.json');
    this.cfg = existsSync(this.configPath)
      ? JSON.parse(readFileSync(this.configPath, 'utf-8'))
      : {};
  }

  list(): Workspace[] {
    return Object.entries(this.cfg.workspaces ?? {}).map(([id, path]) => ({ id, path }));
  }

  add(id: string, path: string): void {
    this.cfg.workspaces ??= {};
    if (id in this.cfg.workspaces) {
      throw new Error(`workspace id '${id}' already exists`);
    }
    this.cfg.workspaces[id] = path;
    this.persist();
  }

  remove(id: string): void {
    if (this.cfg.workspaces && id in this.cfg.workspaces) {
      delete this.cfg.workspaces[id];
      this.persist();
    }
  }

  /** longest-prefix match (used by `tlive mcp` to figure out which ws it's in). */
  lookupByCwd(cwd: string): Workspace | null {
    const all = this.list();
    let best: Workspace | null = null;
    for (const w of all) {
      if (cwd === w.path || cwd.startsWith(w.path + '/')) {
        if (!best || w.path.length > best.path.length) best = w;
      }
    }
    return best;
  }

  private persist(): void {
    writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
  }
}
