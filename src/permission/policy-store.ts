// src/permission/policy-store.ts
//
// Per-workspace persistent allow/deny rules for PermissionRequest auto-
// resolution. Rules match against `toolName` + optional `inputMatch` pattern
// (deep object include with `*` glob on string leaves).
//
// File layout: `~/.tlive/workspaces/<workspaceId>/policies.json`
//   { "rules": [ { id, pattern, decision, scope, createdBy, createdAt } ] }
//
// Saves are atomic (tmp+rename) so a crashing daemon never leaves a half-
// written policies.json. Load is tolerant: missing file / malformed JSON →
// empty rule list. No schema migrations yet — future rules need a `version`
// bump.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PermissionRequest, PermissionDecision } from '../runtime/types.js';

export interface PolicyRule {
  id: string;
  pattern: {
    toolName?: string;
    /** Deep-include pattern applied to `req.toolInput`. String leaves with
     *  `*` treated as glob (`*`→`.*`). Nested objects recurse. */
    inputMatch?: Record<string, unknown>;
  };
  decision: Extract<PermissionDecision, 'allow' | 'deny'>;
  scope: 'workspace' | 'session';
  createdBy: string;
  createdAt: string;
}

export interface PolicyStoreOptions {
  /** Override the default `~/.tlive/workspaces/<id>/policies.json` location. */
  file?: string;
}

export class PolicyStore {
  private rules: PolicyRule[] = [];
  private readonly file: string;

  constructor(workspaceId: string, opts: PolicyStoreOptions = {}) {
    this.file = opts.file ?? join(homedir(), '.tlive', 'workspaces', workspaceId, 'policies.json');
  }

  /** Load rules from disk. Missing or malformed file → empty set. */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { rules?: PolicyRule[] };
      this.rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    } catch {
      this.rules = [];
    }
  }

  /** Atomic save: write to tmp then rename. */
  async save(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ rules: this.rules }, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }

  list(): PolicyRule[] {
    return [...this.rules];
  }

  async add(
    pattern: PolicyRule['pattern'],
    decision: PolicyRule['decision'],
    scope: PolicyRule['scope'],
    createdBy: string,
  ): Promise<PolicyRule> {
    const rule: PolicyRule = {
      id: `pol-${randomBytes(3).toString('hex')}`,
      pattern,
      decision,
      scope,
      createdBy,
      createdAt: new Date().toISOString(),
    };
    this.rules.push(rule);
    await this.save();
    return rule;
  }

  /** Remove a rule by id. Idempotent — missing id returns false. */
  async remove(id: string): Promise<boolean> {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return false;
    await this.save();
    return true;
  }

  /** First matching rule, or null. Rules are checked in insertion order. */
  match(req: PermissionRequest): PolicyRule | null {
    for (const rule of this.rules) {
      if (rule.pattern.toolName && rule.pattern.toolName !== req.toolName) continue;
      if (rule.pattern.inputMatch && !deepIncludes(req.toolInput, rule.pattern.inputMatch)) continue;
      return rule;
    }
    return null;
  }
}

/**
 * Deep object include: every key in `pattern` must be present in `input` with
 * an equal or pattern-matching value. String leaves with `*` are glob-matched
 * (wildcards match any run of characters). Non-object inputs never match.
 *
 * Recursive: nested objects apply deepIncludes again; array patterns fall
 * through to strict equality (matches only identical arrays — `*` inside
 * arrays is not supported yet).
 */
function deepIncludes(input: unknown, pattern: Record<string, unknown>): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  for (const [k, v] of Object.entries(pattern)) {
    if (!(k in obj)) return false;
    if (typeof v === 'string' && v.includes('*')) {
      const leaf = obj[k];
      if (typeof leaf !== 'string' || !globMatch(v, leaf)) return false;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if (!deepIncludes(obj[k], v as Record<string, unknown>)) return false;
    } else {
      if (obj[k] !== v) return false;
    }
  }
  return true;
}

function globMatch(pattern: string, value: string): boolean {
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + pattern.split('*').map(esc).join('.*') + '$');
  return re.test(value);
}
