import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ProjectEntry {
  path: string;
  name: string;
  lastUsed: number; // epoch ms
}

const REGISTRY_PATH = join(homedir(), '.tlive', 'projects.json');

export class ProjectRegistry {
  private projects = new Map<string, ProjectEntry>();

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(REGISTRY_PATH)) return;
    try {
      const data = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
      if (Array.isArray(data)) {
        for (const entry of data) this.projects.set(entry.path, entry);
      }
    } catch { /* corrupted file, start fresh */ }
  }

  private save(): void {
    const dir = join(REGISTRY_PATH, '..');
    mkdirSync(dir, { recursive: true });
    const entries = [...this.projects.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2));
  }

  register(path: string, name?: string): void {
    const existing = this.projects.get(path);
    this.projects.set(path, {
      path,
      name: name ?? existing?.name ?? path.split('/').pop() ?? path,
      lastUsed: Date.now(),
    });
    this.save();
  }

  touch(path: string): void {
    const entry = this.projects.get(path);
    if (entry) { entry.lastUsed = Date.now(); this.save(); }
  }

  list(): ProjectEntry[] {
    return [...this.projects.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  }

  getRecent(): ProjectEntry | undefined {
    return this.list()[0];
  }

  resolve(query: string): ProjectEntry | undefined {
    if (this.projects.has(query)) return this.projects.get(query);
    const lower = query.toLowerCase();
    return this.list().find((p) => p.name.toLowerCase() === lower);
  }

  remove(path: string): boolean {
    const deleted = this.projects.delete(path);
    if (deleted) this.save();
    return deleted;
  }
}
