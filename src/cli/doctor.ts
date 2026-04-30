// src/cli/doctor.ts — `tlive doctor`
//
// Comprehensive structured health check. Spec §12 + §13.
//
// Sections checked:
//   - daemon         running? pid + uptime via IPC `daemon.status`
//   - config         ~/.tlive/config.json present + parseable (schema validate)
//   - anthropic      env keys OR Claude OAuth (~/.claude/.credentials.json) present
//   - openai         env keys OR Codex OAuth (~/.codex/auth.json) present
//   - platforms      telegram / feishu tokens configured
//   - jsonl          ~/.claude/projects + ~/.codex/sessions writability
//   - disk           free space on $HOME partition
//   - warmpool       slot counts (via IPC daemon.status)
//   - workspaces     count of registered workspaces
//   - mcp            registry entries (lists downstream names)
//   - errors24h      tail of recent daemon log errors
//
// Each check emits a Finding({section, level, message, hint?}). The output
// renders with the spec's OK/WARN/FAIL glyphs, collapses a remediation
// section at the end listing every failed check's hint.
//
// All probes fail-soft. Missing subsystems warn, not fail.

import { existsSync, statSync, promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request, getSocketPath } from '../ipc/client.js';
import { parseConfig } from '../config/schema.js';

type Level = 'ok' | 'warn' | 'fail';

interface Finding {
  section: string;
  level: Level;
  message: string;
  hint?: string;
}

function glyph(level: Level): string {
  switch (level) {
    case 'ok': return 'OK  ';
    case 'warn': return 'WARN';
    case 'fail': return 'FAIL';
  }
}

async function checkDaemon(findings: Finding[]): Promise<AdapterStatus | undefined> {
  const sockPath = getSocketPath();
  if (!existsSync(sockPath)) {
    findings.push({
      section: 'daemon',
      level: 'warn',
      message: 'not running',
      hint: 'Run: tlive start',
    });
    return undefined;
  }
  try {
    const resp = await request({ kind: 'daemon.status' }, { timeoutMs: 3000 });
    if (resp.kind !== 'daemon.status') {
      findings.push({ section: 'daemon', level: 'fail', message: `unexpected response: ${resp.kind}` });
      return undefined;
    }
    const uptimeS = Math.round(resp.uptimeMs / 1000);
    findings.push({
      section: 'daemon',
      level: 'ok',
      message: `running (pid ${resp.pid}, uptime ${formatDuration(uptimeS)})`,
    });
    findings.push({
      section: 'sessions',
      level: 'ok',
      message: `${resp.sessionCount} live`,
    });
    findings.push({
      section: 'warmpool',
      level: 'ok',
      message: `${resp.warmPoolCount} parked runtime(s)`,
    });
    return resp.adapters;
  } catch (err) {
    findings.push({
      section: 'daemon',
      level: 'fail',
      message: `unreachable via IPC (${(err as Error).message})`,
      hint: 'Try: tlive stop && tlive start',
    });
    return undefined;
  }
}

async function checkConfig(findings: Finding[], home: string): Promise<{
  raw?: ReturnType<typeof JSON.parse>;
} | undefined> {
  const path = join(home, 'config.json');
  if (!existsSync(path)) {
    findings.push({
      section: 'config',
      level: 'warn',
      message: 'no config.json (first-run?)',
      hint: 'Run: tlive setup',
    });
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    findings.push({
      section: 'config',
      level: 'fail',
      message: `invalid JSON (${(err as Error).message})`,
      hint: `Open ${path} and fix parse errors, or restore from ~/.tlive/config.v0-backup.json`,
    });
    return;
  }
  const parse = parseConfig(raw);
  if (!parse.ok) {
    findings.push({
      section: 'config',
      level: 'fail',
      message: `schema errors: ${parse.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      hint: 'Run: tlive setup — or edit ~/.tlive/config.json',
    });
    return;
  }
  const ws = parse.value.workspaces.length;
  findings.push({
    section: 'config',
    level: ws > 0 ? 'ok' : 'warn',
    message: `v1 schema ok; ${ws} workspace(s)`,
    hint: ws === 0 ? 'Run: tlive setup to add a workspace' : undefined,
  });
  return { raw: parse.value };
}

export interface CheckEnvKeysOptions {
  env?: NodeJS.ProcessEnv;
  claudeHome?: string;
  codexHome?: string;
}

export function checkEnvKeys(findings: Finding[], opts: CheckEnvKeysOptions = {}): void {
  const env = opts.env ?? process.env;
  const claudeHome = opts.claudeHome ?? join(homedir(), '.claude');
  const codexHome = opts.codexHome ?? join(homedir(), '.codex');

  const hasAnthropicKey = Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY);
  const hasClaudeOAuthEnv = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN);
  const hasClaudeOAuthFile = existsSync(join(claudeHome, '.credentials.json'));

  if (hasAnthropicKey) {
    findings.push({ section: 'anthropic', level: 'ok', message: 'ANTHROPIC_API_KEY set' });
  } else if (hasClaudeOAuthEnv) {
    findings.push({ section: 'anthropic', level: 'ok', message: 'CLAUDE_CODE_OAUTH_TOKEN set' });
  } else if (hasClaudeOAuthFile) {
    findings.push({
      section: 'anthropic',
      level: 'ok',
      message: 'Claude OAuth credentials present (~/.claude/.credentials.json)',
    });
  } else {
    findings.push({
      section: 'anthropic',
      level: 'warn',
      message: 'no Claude credentials found',
      hint: 'Run `claude login`, or export ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.',
    });
  }

  const hasOpenAI = Boolean(env.OPENAI_API_KEY);
  const hasCodexAuth = existsSync(join(codexHome, 'auth.json'));
  if (hasOpenAI || hasCodexAuth) {
    findings.push({
      section: 'openai',
      level: 'ok',
      message: hasCodexAuth ? '~/.codex/auth.json present' : 'OPENAI_API_KEY set',
    });
  } else {
    findings.push({
      section: 'openai',
      level: 'warn',
      message: 'no OPENAI_API_KEY and no ~/.codex/auth.json',
      hint: 'Codex runtime needs one of the two. Run: codex login',
    });
  }
}

type AdapterStatus = Partial<Record<'telegram' | 'feishu', 'connected' | 'idle' | 'failed'>>;

export function checkPlatforms(
  findings: Finding[],
  parsed: ReturnType<typeof parseConfig>,
  adapterStatus?: AdapterStatus,
): void {
  if (!parsed.ok) return;
  const c = parsed.value.channels ?? {};
  const any = c.telegram || c.feishu;
  if (!any) {
    findings.push({
      section: 'platforms',
      level: 'warn',
      message: 'no IM platforms configured',
      hint: 'Run: tlive setup to add Telegram / Feishu',
    });
    return;
  }

  const platforms: Array<['telegram' | 'feishu', boolean, string]> = [
    ['telegram', !!c.telegram, c.telegram ? 'token configured' : ''],
    ['feishu',   !!c.feishu,   c.feishu   ? 'appId + appSecret configured' : ''],
  ];

  for (const [name, configured, baseMsg] of platforms) {
    if (!configured) continue;

    if (adapterStatus === undefined) {
      // No adapter info available (e.g., daemon not running, doctor still
      // wants to check config-only). Preserve legacy behavior.
      findings.push({ section: name, level: 'ok', message: baseMsg });
      continue;
    }

    const state = adapterStatus[name];
    if (state === 'connected') {
      findings.push({ section: name, level: 'ok', message: `WSClient connected (${baseMsg})` });
    } else if (state === 'idle') {
      findings.push({
        section: name,
        level: 'warn',
        message: `${baseMsg}, but adapter not connected`,
        hint: `Check tlive daemon-logs for ${name}/ws connection errors`,
      });
    } else if (state === 'failed') {
      findings.push({
        section: name,
        level: 'fail',
        message: `${baseMsg}, but adapter init failed`,
        hint: 'See tlive daemon-logs for stack trace',
      });
    } else {
      findings.push({
        section: name,
        level: 'warn',
        message: `${baseMsg}, but ${name} not in adapter set (daemon may not have started this adapter)`,
        hint: 'Check tlive daemon-logs',
      });
    }
  }
}

async function checkJsonlDirs(findings: Finding[]): Promise<void> {
  const dirs = [
    { label: 'claude jsonl', path: join(homedir(), '.claude', 'projects') },
    { label: 'codex jsonl', path: join(homedir(), '.codex', 'sessions') },
  ];
  for (const d of dirs) {
    try {
      await fs.access(d.path);
      findings.push({
        section: d.label,
        level: 'ok',
        message: `${d.path} accessible`,
      });
    } catch {
      findings.push({
        section: d.label,
        level: 'warn',
        message: `${d.path} missing (first use?)`,
        hint: `Runtime will create it on first session; ensure $HOME is writable.`,
      });
    }
  }
}

async function checkDisk(findings: Finding[], home: string): Promise<void> {
  // statfs (Node 19+) gives us the filesystem free bytes. When unavailable,
  // warn rather than fail.
  const maybeStatfs = (fs as unknown as {
    statfs?: (p: string) => Promise<{ bsize: number; bavail: number }>;
  }).statfs;
  if (!maybeStatfs) {
    findings.push({
      section: 'disk',
      level: 'warn',
      message: 'fs.statfs not available on this Node runtime',
    });
    return;
  }
  try {
    const s = await maybeStatfs(home);
    const freeBytes = s.bsize * s.bavail;
    const freeGb = freeBytes / (1024 ** 3);
    const lvl: Level = freeGb < 1 ? 'fail' : freeGb < 5 ? 'warn' : 'ok';
    findings.push({
      section: 'disk',
      level: lvl,
      message: `${freeGb.toFixed(1)} GB free on ${home}`,
      hint: lvl === 'ok' ? undefined : 'Cost log / jsonl history accumulates. Clean ~/.tlive and ~/.claude/projects as needed.',
    });
  } catch (err) {
    findings.push({ section: 'disk', level: 'warn', message: `statfs failed: ${(err as Error).message}` });
  }
}

async function checkMcpRegistry(findings: Finding[], home: string): Promise<void> {
  const path = join(home, 'mcp-registry.json');
  if (!existsSync(path)) {
    findings.push({
      section: 'mcp',
      level: 'ok',
      message: 'no downstream servers registered (tlive-self built-in only)',
    });
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Array<{ name: string; enabled?: boolean }> };
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    const enabled = entries.filter((e) => e.enabled !== false).map((e) => e.name);
    findings.push({
      section: 'mcp',
      level: 'ok',
      message: entries.length === 0
        ? 'registry empty'
        : `${enabled.length}/${entries.length} enabled: ${enabled.join(', ') || '(none)'}`,
    });
  } catch (err) {
    findings.push({
      section: 'mcp',
      level: 'warn',
      message: `registry unreadable: ${(err as Error).message}`,
    });
  }
}

async function checkRecentErrors(findings: Finding[], home: string): Promise<void> {
  // Only scan the v1.0 daemon log. `~/.tlive/logs/bridge.log` is a v0.x
  // artifact that may linger from a prior install; its error counts are
  // not representative of the v1.0 daemon's health.
  const candidates = [
    join(home, 'daemon.log'),
    join(home, 'logs', 'daemon.log'),
  ];
  const path = candidates.find(existsSync);
  if (!path) {
    findings.push({
      section: 'errors24h',
      level: 'ok',
      message: 'no log file yet',
    });
    return;
  }
  try {
    const st = statSync(path);
    const size = Math.min(st.size, 512 * 1024);
    if (size === 0) {
      findings.push({ section: 'errors24h', level: 'ok', message: 'log empty' });
      return;
    }
    const text = readFileSync(path, 'utf8').slice(-size);
    const since = Date.now() - 24 * 3600 * 1000;
    let errors = 0;
    for (const line of text.split('\n')) {
      if (!/error|fatal|unhandled/i.test(line)) continue;
      // Best-effort timestamp extract: ISO8601 prefix.
      const m = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(line);
      if (m) {
        const t = Date.parse(m[1] + 'Z');
        if (Number.isFinite(t) && t < since) continue;
      }
      errors++;
    }
    findings.push({
      section: 'errors24h',
      level: errors === 0 ? 'ok' : errors < 5 ? 'warn' : 'fail',
      message: `${errors} error line(s) in last 24h (${path})`,
      hint: errors > 0 ? `Inspect with: tlive daemon-logs ${Math.max(50, errors * 3)}` : undefined,
    });
  } catch (err) {
    findings.push({ section: 'errors24h', level: 'warn', message: `log scan failed: ${(err as Error).message}` });
  }
}

function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m ${totalSec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function printFindings(findings: Finding[]): void {
  process.stdout.write('Running tlive doctor…\n\n');
  const sectionWidth = Math.max(10, ...findings.map((f) => f.section.length));
  for (const f of findings) {
    process.stdout.write(`[${glyph(f.level)}] ${f.section.padEnd(sectionWidth)}  ${f.message}\n`);
  }
  const remediation = findings.filter((f) => f.hint && f.level !== 'ok');
  if (remediation.length > 0) {
    process.stdout.write('\nRemediation:\n');
    for (const f of remediation) {
      process.stdout.write(`  - ${f.section}: ${f.hint}\n`);
    }
  }
  const failed = findings.filter((f) => f.level === 'fail').length;
  const warned = findings.filter((f) => f.level === 'warn').length;
  process.stdout.write(`\n${findings.length - failed - warned} ok, ${warned} warn, ${failed} fail\n`);
}

export async function doctorCommand(): Promise<number> {
  const home = join(homedir(), '.tlive');
  const findings: Finding[] = [];

  const adapterStatus = await checkDaemon(findings);
  const configResult = await checkConfig(findings, home);
  const parsed = configResult?.raw ? parseConfig(configResult.raw) : undefined;
  checkEnvKeys(findings);
  if (parsed) checkPlatforms(findings, parsed, adapterStatus);
  await checkJsonlDirs(findings);
  await checkDisk(findings, home);
  await checkMcpRegistry(findings, home);
  await checkRecentErrors(findings, home);

  printFindings(findings);
  const failed = findings.some((f) => f.level === 'fail');
  return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith('tlive-doctor.mjs')) {
  doctorCommand().then((code) => { if (code !== 0) process.exit(code); }).catch((err) => {
    process.stderr.write(`tlive doctor failed: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
