/**
 * Shared constants and helpers for Claude SDK providers.
 * Used by both claude-sdk.ts (single-shot) and claude-live-session.ts (long-lived).
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

export function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.some(prefix => k.startsWith(prefix))) continue;
    out[k] = v;
  }
  return out;
}

// ── Image attachment handling ──

/** Save image attachments to temp files, return modified prompt */
export function preparePromptWithImages(
  prompt: string,
  attachments?: Array<{ type: string; mimeType: string; base64Data: string }>,
): string {
  const images = attachments?.filter(a => a.type === 'image');
  if (!images?.length) return prompt;

  const imgDir = join(tmpdir(), 'tlive-images');
  mkdirSync(imgDir, { recursive: true });
  const paths: string[] = [];
  for (const att of images) {
    const ext = att.mimeType === 'image/png' ? '.png' : att.mimeType === 'image/gif' ? '.gif' : '.jpg';
    const filePath = join(imgDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
    writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
    paths.push(filePath);
  }
  return `[User sent ${paths.length} image(s) — read them to see the content]\n${paths.join('\n')}\n\n${prompt}`;
}

// ── Pre-approved safe permissions ──

export const SAFE_PERMISSIONS = [
  // Read-only tools — always safe
  'Read(*)', 'Glob(*)', 'Grep(*)', 'WebSearch(*)', 'WebFetch(*)',
  'Agent(*)', 'Task(*)', 'TodoRead(*)', 'ToolSearch(*)',
  // Safe Bash commands — read-only, no side effects
  'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(less *)',
  'Bash(wc *)', 'Bash(ls *)', 'Bash(tree *)', 'Bash(find *)',
  'Bash(grep *)', 'Bash(rg *)', 'Bash(ag *)',
  'Bash(file *)', 'Bash(stat *)', 'Bash(du *)', 'Bash(df *)',
  'Bash(which *)', 'Bash(type *)', 'Bash(whereis *)',
  'Bash(echo *)', 'Bash(printf *)', 'Bash(date *)',
  'Bash(pwd)', 'Bash(whoami)', 'Bash(uname *)', 'Bash(env)',
  'Bash(git log *)', 'Bash(git status *)', 'Bash(git diff *)',
  'Bash(git show *)', 'Bash(git blame *)', 'Bash(git branch *)',
  'Bash(node -v *)', 'Bash(npm list *)', 'Bash(npx tsc *)',
  'Bash(go version *)', 'Bash(go list *)',
];

// ── Auth error classification ──

const CLI_AUTH_PATTERNS = [/not logged in/i, /please run \/login/i];
const API_AUTH_PATTERNS = [/unauthorized/i, /invalid.*api.?key/i, /401\b/];

export function classifyAuthError(text: string): 'cli' | 'api' | false {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}
