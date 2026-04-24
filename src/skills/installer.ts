// src/skills/installer.ts
//
// Copy bundled Claude skill + Codex prompt into the user's
// `~/.claude/skills/tlive/` and `~/.codex/prompts/` directories, and patch
// the matching MCP-servers entry into the corresponding settings file.
//
// Design goals:
//   - Idempotent: running the installer twice overwrites templates but
//     leaves the rest of `settings.json` / `config.toml` untouched.
//   - Merge-safe: existing `mcpServers` entries with other keys survive;
//     only the `tlive` entry is rewritten. TOML edits are line-oriented to
//     avoid pulling in a TOML dependency.
//   - Test-friendly: every path is parameterised via `destRoot`, so
//     integration tests can point at a tmpdir.
//
// Source layout is resolved by walking up from this file's URL:
//   dist layout  →  <pkgRoot>/dist/src/skills/installer.js
//   src layout   →  <pkgRoot>/src/skills/installer.ts (under tsx / vitest)
//
// In both cases `<pkgRoot>/src/skills/{claude,codex}/` holds the templates.

import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InstallerOptions {
  /** Override `~/.claude` (Claude) or `~/.codex` (Codex) root for tests. */
  destRoot?: string;
  /** Override the source skills directory (defaults to bundled templates). */
  sourceRoot?: string;
  /** Optional sink for log lines so the CLI can render progress. */
  log?: (line: string) => void;
}

export interface InstallResult {
  destRoot: string;
  filesWritten: string[];
  configPatched: string | null;
}

export interface InstallAllOptions {
  claudeRoot?: string;
  codexRoot?: string;
  sourceRoot?: string;
  log?: (line: string) => void;
}

/** Resolve the effective `~/.claude` root; tests / daemons may override via
 *  `$TLIVE_CLAUDE_HOME`. */
export function claudeHome(): string {
  return process.env.TLIVE_CLAUDE_HOME ?? join(homedir(), '.claude');
}

/** Resolve the effective `~/.codex` root; tests may override via
 *  `$TLIVE_CODEX_HOME`. */
export function codexHome(): string {
  return process.env.TLIVE_CODEX_HOME ?? join(homedir(), '.codex');
}

/** Copy the Claude skill + patch `~/.claude/settings.json`. */
export async function installClaude(opts: InstallerOptions = {}): Promise<InstallResult> {
  const destRoot = opts.destRoot ?? claudeHome();
  const sourceRoot = opts.sourceRoot ?? resolveBundledSkillsDir();
  const log = opts.log ?? (() => undefined);

  const srcSkill = join(sourceRoot, 'claude');
  if (!existsSync(srcSkill)) {
    throw new Error(`bundled Claude skill not found at ${srcSkill}. Reinstall tlive.`);
  }

  const destSkill = join(destRoot, 'skills', 'tlive');
  await fs.mkdir(destSkill, { recursive: true });
  const filesWritten = await copyTree(srcSkill, destSkill, log);

  const settingsPath = join(destRoot, 'settings.json');
  const patched = await patchClaudeSettings(settingsPath, log);

  return { destRoot, filesWritten, configPatched: patched ? settingsPath : null };
}

/** Copy the Codex prompt + patch `~/.codex/config.toml`. */
export async function installCodex(opts: InstallerOptions = {}): Promise<InstallResult> {
  const destRoot = opts.destRoot ?? codexHome();
  const sourceRoot = opts.sourceRoot ?? resolveBundledSkillsDir();
  const log = opts.log ?? (() => undefined);

  const srcPrompt = join(sourceRoot, 'codex', 'tlive.md');
  if (!existsSync(srcPrompt)) {
    throw new Error(`bundled Codex prompt not found at ${srcPrompt}. Reinstall tlive.`);
  }

  const destPromptDir = join(destRoot, 'prompts');
  await fs.mkdir(destPromptDir, { recursive: true });
  const destPrompt = join(destPromptDir, 'tlive.md');
  await fs.copyFile(srcPrompt, destPrompt);
  log(`wrote ${destPrompt}`);

  const configPath = join(destRoot, 'config.toml');
  const patched = await patchCodexConfig(configPath, log);

  return {
    destRoot,
    filesWritten: [destPrompt],
    configPatched: patched ? configPath : null,
  };
}

/** Install both sides. */
export async function installAll(opts: InstallAllOptions = {}): Promise<{
  claude: InstallResult;
  codex: InstallResult;
}> {
  const claude = await installClaude({
    destRoot: opts.claudeRoot,
    sourceRoot: opts.sourceRoot,
    log: opts.log,
  });
  const codex = await installCodex({
    destRoot: opts.codexRoot,
    sourceRoot: opts.sourceRoot,
    log: opts.log,
  });
  return { claude, codex };
}

// ---- Helpers --------------------------------------------------------------

/**
 * Locate the bundled skills directory. When running from `dist/` the
 * installer lives at `dist/src/skills/installer.js`; the templates still
 * live at the package root in `src/skills/`.
 */
export function resolveBundledSkillsDir(): string {
  const here = fileURLToPath(import.meta.url);
  // Walk up until we find a directory that contains `src/skills/claude/`.
  let dir = dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'src', 'skills');
    if (existsSync(join(candidate, 'claude'))) return candidate;
    dir = dirname(dir);
  }
  // Fallback: assume templates live next to the installer (bundled).
  return dirname(here);
}

async function copyTree(src: string, dest: string, log: (s: string) => void): Promise<string[]> {
  const written: string[] = [];
  async function walk(srcDir: string, destDir: string): Promise<void> {
    await fs.mkdir(destDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);
      if (entry.isDirectory()) {
        await walk(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
        // Preserve executable bit for shell scripts.
        if (entry.name.endsWith('.sh')) {
          await fs.chmod(destPath, 0o755).catch(() => undefined);
        }
        written.push(destPath);
        log(`wrote ${destPath}`);
      }
    }
  }
  await walk(src, dest);
  return written;
}

/**
 * Patch `~/.claude/settings.json` so `mcpServers.tlive` points at the
 * current `tlive` CLI. Preserves every other key. The shape follows the
 * public Claude Code settings docs (version as of Claude Code 1.x):
 *
 *   "mcpServers": {
 *     "tlive": { "command": "tlive", "args": ["mcp"] }
 *   }
 *
 * If `permissionPromptToolName` is unset we hint the user about the
 * Companion-mode option via an accompanying `// ` comment — JSON doesn't
 * support comments, so we settle for adding the config key
 * commented-out-style via a prose log line.
 */
async function patchClaudeSettings(
  path: string,
  log: (s: string) => void,
): Promise<boolean> {
  await fs.mkdir(dirname(path), { recursive: true });
  let obj: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(path, 'utf8');
    if (raw.trim()) obj = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot parse ${path}: ${(err as Error).message}`);
    }
  }

  const servers = (obj.mcpServers ?? {}) as Record<string, unknown>;
  const tliveEntry: Record<string, unknown> = {
    command: 'tlive',
    args: ['mcp'],
  };
  servers.tlive = tliveEntry;
  obj.mcpServers = servers;

  await fs.writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  log(`patched ${path} (mcpServers.tlive)`);

  if (!('permissionPromptToolName' in obj)) {
    log(
      'hint: set "permissionPromptToolName": "mcp__tlive__approve" in ' +
      `${path} for Companion-mode remote approvals.`,
    );
  }
  return true;
}

/**
 * Patch `~/.codex/config.toml` with an `[mcp_servers.tlive]` section. We
 * keep the edit line-oriented so we don't need to pull in a TOML library.
 *
 * Rules:
 *   - If the section already exists, we rewrite it in place.
 *   - If it doesn't, we append it to the bottom of the file.
 *   - Every other line (comments, unrelated sections) stays exactly as-is.
 */
async function patchCodexConfig(
  path: string,
  log: (s: string) => void,
): Promise<boolean> {
  await fs.mkdir(dirname(path), { recursive: true });
  let text = '';
  try { text = await fs.readFile(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const lines = text === '' ? [] : text.split('\n');
  const sectionHeader = '[mcp_servers.tlive]';
  const desired = [
    sectionHeader,
    'command = "tlive"',
    'args = ["mcp"]',
  ];

  const startIdx = lines.findIndex((l) => l.trim() === sectionHeader);
  if (startIdx === -1) {
    // Append (with a leading blank line if the file doesn't already end in one).
    const needsBlank = lines.length > 0 && lines[lines.length - 1]!.trim() !== '';
    if (needsBlank) lines.push('');
    lines.push(...desired);
    lines.push('');
  } else {
    // Replace keys until the next section header (or EOF).
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i]!)) { endIdx = i; break; }
    }
    lines.splice(startIdx, endIdx - startIdx, ...desired);
    if (endIdx !== lines.length && lines[startIdx + desired.length]?.trim() !== '') {
      lines.splice(startIdx + desired.length, 0, '');
    }
  }

  const out = lines.join('\n');
  await fs.writeFile(path, out.endsWith('\n') ? out : out + '\n', 'utf8');
  log(`patched ${path} ([mcp_servers.tlive])`);
  return true;
}

// ---- Skill / agent FS helpers for T7 commands ----------------------------

export interface SkillEntry {
  name: string;
  path: string;
}

/** List skills installed under `~/.claude/skills/`. */
export async function listClaudeSkills(
  destRoot: string = claudeHome(),
): Promise<SkillEntry[]> {
  const root = join(destRoot, 'skills');
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(root, e.name) }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Install a skill from a local directory OR a single `.md` file into
 * `~/.claude/skills/<name>/`. For URLs the caller should pre-download; we
 * deliberately refuse remote fetches so the installer stays offline-safe.
 */
export async function installClaudeSkill(
  source: string,
  opts: { destRoot?: string; name?: string } = {},
): Promise<SkillEntry> {
  const destRoot = opts.destRoot ?? claudeHome();
  if (/^https?:\/\//i.test(source)) {
    throw new Error('URL skills not supported offline; download first then pass the local path.');
  }
  const stat = await fs.stat(source);
  const name = opts.name
    ?? (stat.isDirectory() ? basename(source) : basename(source, '.md'));
  const dest = join(destRoot, 'skills', name);
  await fs.mkdir(dest, { recursive: true });
  if (stat.isDirectory()) {
    await copyTree(source, dest, () => undefined);
  } else {
    await fs.copyFile(source, join(dest, 'SKILL.md'));
  }
  return { name, path: dest };
}

/** Remove a skill directory from `~/.claude/skills/`. Returns `false` when
 *  the directory wasn't present (distinct from a removal error). */
export async function removeClaudeSkill(
  name: string,
  opts: { destRoot?: string } = {},
): Promise<boolean> {
  const destRoot = opts.destRoot ?? claudeHome();
  const dir = join(destRoot, 'skills', name);
  if (!existsSync(dir)) return false;
  try { await fs.rm(dir, { recursive: true, force: true }); return true; }
  catch { return false; }
}

export interface AgentSpec {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
}

/** Write a `~/.claude/agents/<name>.md` file. */
export async function writeClaudeAgent(
  spec: AgentSpec,
  opts: { destRoot?: string } = {},
): Promise<string> {
  const destRoot = opts.destRoot ?? claudeHome();
  const dir = join(destRoot, 'agents');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${spec.name}.md`);
  const frontmatter: string[] = ['---', `name: ${spec.name}`];
  if (spec.description) frontmatter.push(`description: ${spec.description}`);
  if (spec.model) frontmatter.push(`model: ${spec.model}`);
  if (spec.tools && spec.tools.length > 0) {
    frontmatter.push(`tools: [${spec.tools.map((t) => `"${t}"`).join(', ')}]`);
  }
  frontmatter.push('---', '');
  const body = spec.description
    ? `${spec.description}\n`
    : `# ${spec.name}\n\nSubagent scaffold. Describe the agent's responsibilities here.\n`;
  await fs.writeFile(path, frontmatter.join('\n') + body, 'utf8');
  return path;
}

/** Remove a `~/.claude/agents/<name>.md` file. */
export async function removeClaudeAgent(
  name: string,
  opts: { destRoot?: string } = {},
): Promise<boolean> {
  const destRoot = opts.destRoot ?? claudeHome();
  const path = join(destRoot, 'agents', `${name}.md`);
  try { await fs.rm(path); return true; }
  catch { return false; }
}
