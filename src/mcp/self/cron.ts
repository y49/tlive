// src/mcp/self/cron.ts
//
// CronEngine — persistent scheduled tasks fired in-daemon.
//
// Precision: the scheduler advances via a setInterval tick (default 60_000 ms).
// That means `at` / `daily` / `weekly` / 5-field `cron` targets fire within
// **60 seconds** of the wall-clock target, not on the second. Second-precision
// scheduling is **not supported** in v1; plumb a finer tickMs via
// CronEngineOptions only if you know the cost.
//
// Scope: minimal, good-enough-for-v1 cron parser. Supports:
//   - `daily: "HH:MM"` — fires every day at HH:MM local time.
//   - `weekly: { day: "monday" | ..., at: "HH:MM" }`
//   - `at: "2026-04-25T14:00:00Z"` — fires once at an absolute ISO8601 instant.
//   - `cron: "MIN HOUR DOM MON DOW"` — classic 5-field cron; supports "*" and
//     plain integers only (no ranges / lists / steps). Enough for "0 9 * * *".
//
// On fire: `SessionManager.createLocal(...)` with the prompt, wait for the
// `session_complete` event, ship a summary through `IMNotifier`, then stop
// the session. Failures are logged to console.error and swallowed.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpToolDeps } from './deps.js';
import type { LocalSession } from '../../session/local-session.js';
import type { AgentProvider } from '../../runtime/types.js';

export interface ScheduledTask {
  id: string;
  cron: string | null;
  at: string | null;
  daily: string | null;
  weekly: { day: string; at: string } | null;
  workspaceId: string;
  prompt: string;
  provider: AgentProvider;
  createdAt: string;
  lastRunAt?: string;
}

interface ScheduleFile { tasks: ScheduledTask[] }

interface CronEngineOptions {
  /** Override tick interval (ms) for tests. Default: 60_000. */
  tickMs?: number;
  /** Hook callable from tests to advance "now". Default: Date.now. */
  now?: () => number;
  /** Override the file location. Default: ~/.tlive/schedules.json. */
  file?: string;
  /** Stubbable session executor; production plumbs SessionManager.createLocal. */
  executor?: (task: ScheduledTask) => Promise<void>;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ALIASES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

/** Match `"monday" | "Monday" | "mon" | "Mon"` to 0-6 (Sunday=0). */
function parseDayName(raw: string): number {
  const low = raw.trim().toLowerCase();
  const full = DAYS.indexOf(low);
  if (full >= 0) return full;
  const alias = DAY_ALIASES[low];
  return alias === undefined ? -1 : alias;
}

/** Pure cron-ish check: "does this task fire at this instant?" */
export function shouldFireAt(task: ScheduledTask, atMs: number, lastRunMs?: number): boolean {
  const d = new Date(atMs);
  const minute = d.getMinutes();
  const hour = d.getHours();
  const dom = d.getDate();
  const mon = d.getMonth() + 1;
  const dow = d.getDay();
  const minuteStartMs = Math.floor(atMs / 60_000) * 60_000;

  if (lastRunMs !== undefined && lastRunMs >= minuteStartMs) return false;

  if (task.at) {
    const target = Date.parse(task.at);
    if (isNaN(target)) return false;
    return atMs >= target && (!lastRunMs || lastRunMs < target);
  }

  if (task.daily) {
    const [h, m] = task.daily.split(':').map((s) => Number(s));
    return h === hour && m === minute;
  }

  if (task.weekly) {
    const day = parseDayName(task.weekly.day);
    if (day < 0) return false;
    const [h, m] = task.weekly.at.split(':').map((s) => Number(s));
    return dow === day && h === hour && m === minute;
  }

  if (task.cron) {
    const parts = task.cron.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const fit = (actual: number, field: string) => field === '*' || Number(field) === actual;
    return fit(minute, parts[0]!)
      && fit(hour, parts[1]!)
      && fit(dom, parts[2]!)
      && fit(mon, parts[3]!)
      && fit(dow, parts[4]!);
  }
  return false;
}

export class CronEngine {
  private tasks: ScheduledTask[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: McpToolDeps;
  private readonly options: CronEngineOptions;
  private readonly file: string;

  constructor(deps: McpToolDeps, options: CronEngineOptions = {}) {
    this.deps = deps;
    this.options = options;
    this.file = options.file ?? join(deps.dataDir ?? join(homedir(), '.tlive'), 'schedules.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as ScheduleFile;
      this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    } catch { this.tasks = []; }
  }

  async save(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify({ tasks: this.tasks }, null, 2), 'utf8');
  }

  list(): ScheduledTask[] { return [...this.tasks]; }

  async add(input: Omit<ScheduledTask, 'id' | 'createdAt'>): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: `sch-${randomBytes(4).toString('hex')}`,
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.tasks.push(task);
    await this.save();
    return task;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) return false;
    await this.save();
    return true;
  }

  /** Trigger a single tick — exported for fake-timer tests. */
  async tick(atMs?: number): Promise<ScheduledTask[]> {
    const now = atMs ?? (this.options.now ?? Date.now)();
    const fired: ScheduledTask[] = [];
    for (const t of this.tasks) {
      const last = t.lastRunAt ? Date.parse(t.lastRunAt) : undefined;
      if (shouldFireAt(t, now, last)) {
        t.lastRunAt = new Date(now).toISOString();
        fired.push(t);
        try { await this.fire(t); }
        catch (err) { console.error(`[cron] task ${t.id} fire failed:`, err); }
      }
    }
    if (fired.length > 0) await this.save();
    return fired;
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.options.tickMs ?? 60_000;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[cron] tick failed:', err));
    }, tickMs);
    // Node default: unref so cron doesn't block process exit.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async fire(task: ScheduledTask): Promise<void> {
    if (this.options.executor) { await this.options.executor(task); return; }
    const ws = this.deps.workspaces.get(task.workspaceId);
    const workdir = ws?.workdir ?? process.cwd();
    let session: LocalSession | null = null;
    try {
      session = await this.deps.sessions.createLocal({
        workspaceId: task.workspaceId,
        provider: task.provider,
        workdir,
        initialPrompt: task.prompt,
        source: 'cli',
      });
      // Wait for session_complete then notify.
      await new Promise<void>((resolve) => {
        const unsub = session!.onEvent((e) => {
          if (e.kind === 'session_complete') {
            unsub();
            this.deps.notifier.notify(
              session!.id,
              `[schedule] ${task.id} finished: ${e.summary.slice(0, 200)}`,
            );
            resolve();
          }
        });
      });
    } finally {
      if (session) await this.deps.sessions.stop(session.id).catch(() => undefined);
    }
  }
}

// ---- Singleton --------------------------------------------------------------

let singleton: CronEngine | null = null;

export async function getCronEngine(deps: McpToolDeps): Promise<CronEngine> {
  if (singleton) return singleton;
  const engine = new CronEngine(deps);
  await engine.load();
  singleton = engine;
  return engine;
}

/** Testing helper: wipe the singleton so tests start clean. */
export function resetCronEngineForTests(): void { singleton = null; }
