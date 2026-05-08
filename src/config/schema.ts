// src/config/schema.ts
//
// Validated schema for the v1.0 tlive config tree (spec §14.1).
//
// We intentionally avoid adding a runtime dep on `zod` — the shape is
// simple and hand-rolled validators keep the install surface minimal. The
// `parseConfig` function below mirrors zod's behaviour: returns either
// `{ ok: true, value }` or `{ ok: false, issues }`. Each issue carries a
// path + message so the daemon can surface actionable errors.
//
// Schema top-level (see spec §14.1):
//   {
//     version: "1",
//     daemon: { socketPath?, logLevel?, idleHours?, healthPort? },
//     workspaces: [ WorkspaceConfig, ... ],
//     channels: { telegram?, feishu? },
//     permissions: { allowedUsers?, defaults? },
//     schedules: [ ... ],
//     mcpRegistry: Record<string, McpServerEntry>,
//   }
//
// Everything except `version` and `workspaces` is optional; unknown keys at
// the top level are allowed so forward-compat fields don't break the parser
// but are reported as warnings.

import type { AgentProvider, Effort, PermissionMode, ThinkingLevel } from '../runtime/types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DaemonConfig {
  /** Unix socket path. Default: `~/.tlive/daemon.sock`. */
  socketPath?: string;
  logLevel?: LogLevel;
  /** Idle-stop threshold in hours. Default: 24. */
  idleHours?: number;
  /** Health HTTP port. Default: disabled (undefined). */
  healthPort?: number;
  /** Hours a session may be inactive before auto-resume is skipped. Default: 24. */
  resumeCutoffHours?: number;
}

export interface WorkspaceConfigEntry {
  id?: string;
  name: string;
  workdir: string;
  gitRemote?: string;
  defaults?: {
    provider?: AgentProvider;
    model?: string;
    effort?: Effort;
    permissionMode?: PermissionMode;
    thinking?: ThinkingLevel;
    budgetUsd?: number;
    systemPromptAppend?: string;
  };
  budget?: { dailyUsd?: number; monthlyUsd?: number };
}

export interface TelegramChannelConfig {
  token: string;
  /** Optional single-chat binding for legacy config. */
  chatId?: string;
}
export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  /** International edition. Default false → uses Domain.Feishu (China). */
  lark?: boolean;
}

export interface PermissionsConfig {
  /** IM user ids allowed to drive sessions; empty = allow-all. */
  allowedUsers?: string[];
  /** Per-category default decision. */
  defaults?: Partial<Record<'exec' | 'fs_write' | 'network' | 'mcp', 'allow' | 'deny' | 'ask'>>;
}

export interface ScheduleEntry {
  id: string;
  workspaceId: string;
  cron?: string;
  at?: string;
  daily?: string;
  weekly?: { day: string; at: string };
  prompt: string;
  provider?: AgentProvider;
}

export interface McpRegistryEntry {
  enabled?: boolean;
  autoSpawn?: boolean;
  workspaceIds?: string[];
  config: {
    type: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  };
}

export interface TliveConfigV1 {
  version: '1';
  daemon?: DaemonConfig;
  workspaces: WorkspaceConfigEntry[];
  channels?: {
    telegram?: TelegramChannelConfig;
    feishu?: FeishuChannelConfig;
  };
  permissions?: PermissionsConfig;
  schedules?: ScheduleEntry[];
  mcpRegistry?: Record<string, McpRegistryEntry>;
}

export interface ParseIssue {
  path: string;
  message: string;
}

export type ParseResult<T> =
  | { ok: true; value: T; warnings: ParseIssue[] }
  | { ok: false; issues: ParseIssue[] };

// ---- Validators ------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function pushIfMissing(issues: ParseIssue[], cond: boolean, path: string, msg: string): boolean {
  if (!cond) issues.push({ path, message: msg });
  return cond;
}

const PROVIDERS: AgentProvider[] = ['claude', 'codex'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'max'];
const PERM_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const THINK_LEVELS: ThinkingLevel[] = ['collapsed', 'expanded', 'hidden'];
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Parse + validate a raw config value into `TliveConfigV1`. Returns ok with
 * warnings (non-fatal issues) or a list of fatal issues.
 */
export function parseConfig(raw: unknown): ParseResult<TliveConfigV1> {
  const issues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];

  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: '', message: 'config must be an object' }] };
  }

  if (raw.version !== '1') {
    issues.push({ path: 'version', message: `expected "1", got ${JSON.stringify(raw.version)}` });
  }

  const out: TliveConfigV1 = {
    version: '1',
    workspaces: [],
  };

  // daemon
  if (raw.daemon !== undefined) {
    if (!isObject(raw.daemon)) {
      issues.push({ path: 'daemon', message: 'must be an object' });
    } else {
      const d = raw.daemon;
      const dc: DaemonConfig = {};
      if (d.socketPath !== undefined) {
        if (typeof d.socketPath !== 'string') issues.push({ path: 'daemon.socketPath', message: 'must be string' });
        else dc.socketPath = d.socketPath;
      }
      if (d.logLevel !== undefined) {
        if (typeof d.logLevel !== 'string' || !LOG_LEVELS.includes(d.logLevel as LogLevel)) {
          issues.push({ path: 'daemon.logLevel', message: `must be one of ${LOG_LEVELS.join('|')}` });
        } else dc.logLevel = d.logLevel as LogLevel;
      }
      if (d.idleHours !== undefined) {
        if (typeof d.idleHours !== 'number' || d.idleHours <= 0) issues.push({ path: 'daemon.idleHours', message: 'must be positive number' });
        else dc.idleHours = d.idleHours;
      }
      if (d.healthPort !== undefined) {
        if (typeof d.healthPort !== 'number' || d.healthPort < 0 || d.healthPort > 65535) {
          issues.push({ path: 'daemon.healthPort', message: 'must be 0..65535' });
        } else dc.healthPort = d.healthPort;
      }
      if (d.resumeCutoffHours !== undefined) {
        if (typeof d.resumeCutoffHours !== 'number' || d.resumeCutoffHours <= 0) {
          issues.push({ path: 'daemon.resumeCutoffHours', message: 'must be positive number' });
        } else dc.resumeCutoffHours = d.resumeCutoffHours;
      }
      out.daemon = dc;
    }
  }

  // workspaces
  if (raw.workspaces === undefined) {
    // Empty-tolerant: a v1 config with no workspaces is fine (setup wizard
    // registers one). Record as a warning so `tlive doctor` can prompt.
    warnings.push({ path: 'workspaces', message: 'no workspaces configured' });
  } else if (!Array.isArray(raw.workspaces)) {
    issues.push({ path: 'workspaces', message: 'must be an array' });
  } else {
    const seen = new Set<string>();
    raw.workspaces.forEach((w, i) => {
      const path = `workspaces[${i}]`;
      if (!isObject(w)) {
        issues.push({ path, message: 'must be an object' });
        return;
      }
      if (!pushIfMissing(issues, typeof w.name === 'string' && w.name.length > 0, `${path}.name`, 'required non-empty string')) return;
      if (!pushIfMissing(issues, typeof w.workdir === 'string' && w.workdir.length > 0, `${path}.workdir`, 'required non-empty string')) return;
      const entry: WorkspaceConfigEntry = {
        id: typeof w.id === 'string' ? w.id : undefined,
        name: w.name as string,
        workdir: w.workdir as string,
        gitRemote: typeof w.gitRemote === 'string' ? w.gitRemote : undefined,
      };
      if (entry.id && seen.has(entry.id)) issues.push({ path: `${path}.id`, message: 'duplicate id' });
      if (entry.id) seen.add(entry.id);
      if (isObject(w.defaults)) {
        const d = w.defaults;
        entry.defaults = {};
        if (d.provider !== undefined) {
          if (!PROVIDERS.includes(d.provider as AgentProvider)) {
            issues.push({ path: `${path}.defaults.provider`, message: `must be one of ${PROVIDERS.join('|')}` });
          } else entry.defaults.provider = d.provider as AgentProvider;
        }
        if (d.effort !== undefined) {
          if (!EFFORTS.includes(d.effort as Effort)) issues.push({ path: `${path}.defaults.effort`, message: `must be one of ${EFFORTS.join('|')}` });
          else entry.defaults.effort = d.effort as Effort;
        }
        if (d.permissionMode !== undefined) {
          if (!PERM_MODES.includes(d.permissionMode as PermissionMode)) issues.push({ path: `${path}.defaults.permissionMode`, message: `must be one of ${PERM_MODES.join('|')}` });
          else entry.defaults.permissionMode = d.permissionMode as PermissionMode;
        }
        if (d.thinking !== undefined) {
          if (!THINK_LEVELS.includes(d.thinking as ThinkingLevel)) issues.push({ path: `${path}.defaults.thinking`, message: `must be one of ${THINK_LEVELS.join('|')}` });
          else entry.defaults.thinking = d.thinking as ThinkingLevel;
        }
        if (d.model !== undefined) {
          if (typeof d.model !== 'string') issues.push({ path: `${path}.defaults.model`, message: 'must be string' });
          else entry.defaults.model = d.model;
        }
        if (d.budgetUsd !== undefined) {
          if (typeof d.budgetUsd !== 'number') issues.push({ path: `${path}.defaults.budgetUsd`, message: 'must be number' });
          else entry.defaults.budgetUsd = d.budgetUsd;
        }
        if (d.systemPromptAppend !== undefined) {
          if (typeof d.systemPromptAppend !== 'string') issues.push({ path: `${path}.defaults.systemPromptAppend`, message: 'must be string' });
          else entry.defaults.systemPromptAppend = d.systemPromptAppend;
        }
      }
      if (isObject(w.budget)) {
        const b = w.budget;
        entry.budget = {};
        if (b.dailyUsd !== undefined) {
          if (typeof b.dailyUsd !== 'number') issues.push({ path: `${path}.budget.dailyUsd`, message: 'must be number' });
          else entry.budget.dailyUsd = b.dailyUsd;
        }
        if (b.monthlyUsd !== undefined) {
          if (typeof b.monthlyUsd !== 'number') issues.push({ path: `${path}.budget.monthlyUsd`, message: 'must be number' });
          else entry.budget.monthlyUsd = b.monthlyUsd;
        }
      }
      out.workspaces.push(entry);
    });
  }

  // channels
  if (raw.channels !== undefined) {
    if (!isObject(raw.channels)) {
      issues.push({ path: 'channels', message: 'must be an object' });
    } else {
      out.channels = {};
      const c = raw.channels;
      if (c.telegram !== undefined) {
        if (!isObject(c.telegram) || typeof c.telegram.token !== 'string' || c.telegram.token.length === 0) {
          issues.push({ path: 'channels.telegram', message: 'requires token: string' });
        } else {
          out.channels.telegram = {
            token: c.telegram.token,
            chatId: typeof c.telegram.chatId === 'string' ? c.telegram.chatId : undefined,
          };
        }
      }
      if (c.feishu !== undefined) {
        if (!isObject(c.feishu) || typeof c.feishu.appId !== 'string' || typeof c.feishu.appSecret !== 'string') {
          issues.push({ path: 'channels.feishu', message: 'requires appId + appSecret strings' });
        } else {
          const fe: FeishuChannelConfig = { appId: c.feishu.appId, appSecret: c.feishu.appSecret };
          if (c.feishu.lark !== undefined) {
            if (typeof c.feishu.lark !== 'boolean') {
              issues.push({ path: 'channels.feishu.lark', message: 'must be boolean' });
            } else {
              fe.lark = c.feishu.lark;
            }
          }
          out.channels.feishu = fe;
        }
      }
    }
  }

  // permissions
  if (raw.permissions !== undefined) {
    if (!isObject(raw.permissions)) {
      issues.push({ path: 'permissions', message: 'must be an object' });
    } else {
      const p = raw.permissions;
      out.permissions = {};
      if (p.allowedUsers !== undefined) {
        if (!Array.isArray(p.allowedUsers) || p.allowedUsers.some((u) => typeof u !== 'string')) {
          issues.push({ path: 'permissions.allowedUsers', message: 'must be string[]' });
        } else out.permissions.allowedUsers = p.allowedUsers as string[];
      }
      if (p.defaults !== undefined) {
        if (!isObject(p.defaults)) {
          issues.push({ path: 'permissions.defaults', message: 'must be an object' });
        } else {
          const valid = new Set(['allow', 'deny', 'ask']);
          out.permissions.defaults = {};
          for (const [k, v] of Object.entries(p.defaults)) {
            if (!['exec', 'fs_write', 'network', 'mcp'].includes(k)) {
              warnings.push({ path: `permissions.defaults.${k}`, message: 'unknown category; ignored' });
              continue;
            }
            if (typeof v !== 'string' || !valid.has(v)) {
              issues.push({ path: `permissions.defaults.${k}`, message: 'must be allow|deny|ask' });
            } else (out.permissions.defaults as Record<string, 'allow' | 'deny' | 'ask'>)[k] = v as 'allow' | 'deny' | 'ask';
          }
        }
      }
    }
  }

  // schedules
  if (raw.schedules !== undefined) {
    if (!Array.isArray(raw.schedules)) {
      issues.push({ path: 'schedules', message: 'must be an array' });
    } else {
      out.schedules = [];
      raw.schedules.forEach((s, i) => {
        const path = `schedules[${i}]`;
        if (!isObject(s)) { issues.push({ path, message: 'must be object' }); return; }
        if (typeof s.id !== 'string' || typeof s.workspaceId !== 'string' || typeof s.prompt !== 'string') {
          issues.push({ path, message: 'requires id, workspaceId, prompt strings' });
          return;
        }
        const hasSchedule = ['cron', 'at', 'daily', 'weekly'].some((k) => (s as Record<string, unknown>)[k] !== undefined);
        if (!hasSchedule) { issues.push({ path, message: 'requires one of cron|at|daily|weekly' }); return; }
        out.schedules!.push(s as unknown as ScheduleEntry);
      });
    }
  }

  // mcpRegistry
  if (raw.mcpRegistry !== undefined) {
    if (!isObject(raw.mcpRegistry)) {
      issues.push({ path: 'mcpRegistry', message: 'must be an object' });
    } else {
      out.mcpRegistry = {};
      for (const [name, entry] of Object.entries(raw.mcpRegistry)) {
        if (!isObject(entry) || !isObject(entry.config)) {
          issues.push({ path: `mcpRegistry.${name}`, message: 'must include config object' });
          continue;
        }
        const cfg = entry.config;
        if (typeof cfg.type !== 'string' || !['stdio', 'sse', 'http'].includes(cfg.type)) {
          issues.push({ path: `mcpRegistry.${name}.config.type`, message: 'must be stdio|sse|http' });
          continue;
        }
        out.mcpRegistry[name] = entry as unknown as McpRegistryEntry;
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: out, warnings };
}

/** Convenience: throw on invalid, return value on success. */
export function assertConfig(raw: unknown): TliveConfigV1 {
  const r = parseConfig(raw);
  if (!r.ok) {
    const summary = r.issues.map((i) => `${i.path}: ${i.message}`).join('\n  ');
    throw new Error(`invalid tlive config:\n  ${summary}`);
  }
  return r.value;
}
