// Consistency checks ("tlive doctor", CI edition) — three surfaces must
// agree: plugins/claude hooks.json ↔ the shim's canonical event list
// (HOOK_EVENT_NAMES; handler coverage is enforced at compile time by the
// exhaustive switch in normalizer.ts) ↔ docs/manual-hooks.md. Plus the
// version discipline: both bundled plugin.json in lockstep, and any change
// to plugins/** must come with a version bump + lock refresh.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_EVENT_NAMES } from '../../hook/normalizer';
// @ts-expect-error plain .mjs helper shared with the CLI updater script
import { REPO_ROOT, computePluginContentHash, readPluginVersions, readLock } from '../../../../scripts/plugin-lock.mjs';

const HOOKS_JSON_PATH = join(REPO_ROOT, 'plugins/claude/plugins/tlive/hooks/hooks.json');
const MANUAL_HOOKS_PATH = join(REPO_ROOT, 'docs/manual-hooks.md');

type HooksJson = { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> };

function shimEventsOf(hooksJson: HooksJson): string[] {
  return Object.values(hooksJson.hooks)
    .flatMap((entries) => entries.flatMap((e) => e.hooks))
    .map((h) => {
      const m = /^tlive hook (\S+)$/.exec(h.command);
      expect(m, `unexpected hook command shape: ${h.command}`).toBeTruthy();
      return m![1];
    });
}

describe('plugin hooks.json ↔ shim event list', () => {
  const hooksJson = JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf-8')) as HooksJson;

  it('every hooks.json entry maps to a shim event, and every shim event is registered', () => {
    expect(shimEventsOf(hooksJson).sort()).toEqual([...HOOK_EVENT_NAMES].sort());
  });

  it('all entries are synchronous command hooks except Stop (async continue channel)', () => {
    // Only a SYNCHRONOUS command PermissionRequest hook can return a decision
    // (doc-locked 2026-07-21); an accidental async:true on any gating hook
    // would silently break remote approvals.
    for (const [event, entries] of Object.entries(hooksJson.hooks)) {
      for (const h of entries.flatMap((e) => e.hooks)) {
        expect(h.type).toBe('command');
        const async = (h as { async?: boolean }).async === true;
        expect(async, `${event} async flag`).toBe(event === 'Stop');
      }
    }
  });
});

describe('docs/manual-hooks.md ↔ plugin hooks.json', () => {
  it('the doc\'s fenced hooks block is byte-for-byte semantically equal to the shipped hooks.json', () => {
    const doc = readFileSync(MANUAL_HOOKS_PATH, 'utf-8');
    const fences = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const withHooks = fences.filter((f) => f.includes('"hooks"') && f.includes('tlive hook'));
    expect(withHooks.length, 'manual-hooks.md must carry exactly one hooks config block').toBe(1);
    expect(JSON.parse(withHooks[0])).toEqual(JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf-8')));
  });
});

describe('plugin version discipline', () => {
  it('claude and codex bundled plugin versions are in lockstep', () => {
    const v = readPluginVersions();
    expect(v.claude).toBe(v.codex);
  });

  it('plugins/** content changes require a version bump + lock refresh', () => {
    const lock = readLock() as { version: string; hash: string };
    const hash = computePluginContentHash();
    const version = readPluginVersions().claude;
    if (hash !== lock.hash) {
      expect.fail(
        `plugins/** content changed since the lock (version ${lock.version}). ` +
        `Bump BOTH plugin.json versions (content changes must bump, users\' cache ` +
        `only refreshes on a new version) and run: node scripts/plugin-lock.mjs --update`,
      );
    }
    expect(version, 'lock is stale: run node scripts/plugin-lock.mjs --update').toBe(lock.version);
  });
});
