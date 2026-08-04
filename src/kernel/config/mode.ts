// src/kernel/config/mode.ts
//
// The posture ladder — tlive's ONE answer to "how much does tlive intercept".
// It lives in config.json rather than daemon runtime state for two reasons: the
// hook SHIM reads it on every event (before any IPC, which is what makes
// `notify` unable to hang anything), and "I'm out" must survive a daemon
// restart. Everything that displays or writes a posture goes through this file
// — three separately-worded blurbs (CLI, status, IM) is how they drift apart.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ShimMode } from '../hook/normalizer.js';

/** Escalation order — index = how much tlive intercepts. */
export const MODES: readonly ShimMode[] = ['off', 'notify', 'full', 'all'];

export const MODE_DESC: Record<ShimMode, string> = {
  off: 'off — hooks are no-ops: no approval gating, no notifications, no monitoring.',
  notify: 'notify — reports to the machine (desktop toast + dashboard); approvals stay 100% native and IM stays quiet about dialogs only your terminal can answer (turn remote approval on with `tlive mode full`, which puts approvals on your phone).',
  full: 'full — main-session approvals are held for a remote answer, in parallel with the terminal dialog (first answer wins). Sub-agent prompts pass through to the terminal.',
  all: 'all — sub-agent approvals are held too. A held sub-agent has NO terminal dialog until the window ends, so use this when nobody is at the keyboard (`tlive mode full` to go back).',
};

/** Persist the posture; returns the config path written. Reads the RAW file
 *  (not loadConfig, which allowlists `web`) so every other field round-trips
 *  untouched — this only ever flips `mode`. An unparsable config is replaced
 *  rather than thrown on: refusing to write would strand the user with a
 *  posture they cannot change. */
export function writeMode(home: string, mode: ShimMode): string {
  const path = join(home, 'config.json');
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf-8')); } catch { cfg = {}; }
  } else {
    mkdirSync(home, { recursive: true });
  }
  cfg.mode = mode;
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}
