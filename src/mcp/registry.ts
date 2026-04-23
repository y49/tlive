// src/mcp/registry.ts
//
// Persistent registry of downstream MCP servers tlive-self federates.
// File layout: `~/.tlive/mcp-registry.json`
//   { version: 1, entries: RegistryEntry[] }

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { McpServerConfig } from '../runtime/types.js';

export interface RegistryEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  autoSpawn?: boolean;
  /** Optional: which workspace ids may invoke this downstream. Empty = all. */
  workspaceIds?: string[];
}

interface RegistryFile { version: 1; entries: RegistryEntry[] }

export interface RegistryOptions {
  /** Override default `~/.tlive/mcp-registry.json`. Tests pass a temp path. */
  file?: string;
}

export class McpRegistry {
  private entries: RegistryEntry[] = [];
  private readonly file: string;

  constructor(opts: RegistryOptions = {}) {
    this.file = opts.file ?? join(homedir(), '.tlive', 'mcp-registry.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8');
  }

  list(): RegistryEntry[] { return [...this.entries]; }

  get(name: string): RegistryEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  async add(entry: RegistryEntry): Promise<void> {
    this.entries = this.entries.filter((e) => e.name !== entry.name);
    this.entries.push(entry);
    await this.save();
  }

  async remove(name: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.name !== name);
    if (this.entries.length === before) return false;
    await this.save();
    return true;
  }

  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) return false;
    entry.enabled = enabled;
    await this.save();
    return true;
  }

  /** True if the entry is enabled AND the workspace is allowed. */
  isAllowedForWorkspace(name: string, workspaceId: string): boolean {
    const entry = this.get(name);
    if (!entry || !entry.enabled) return false;
    if (!entry.workspaceIds || entry.workspaceIds.length === 0) return true;
    return entry.workspaceIds.includes(workspaceId);
  }
}
