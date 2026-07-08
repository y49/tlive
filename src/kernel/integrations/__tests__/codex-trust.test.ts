// src/kernel/integrations/__tests__/codex-trust.test.ts
import { describe, it, expect } from 'vitest';
import { codexHookState } from '../codex-trust';

const P = '/home/u/.codex/hooks.json';
describe('codexHookState', () => {
  it('未装', () => {
    expect(codexHookState({ hooksJsonExists: false, configTomlText: null, hooksJsonPath: P })).toBe('not-installed');
  });
  it('装了但 config 无 trust 记录 → untrusted', () => {
    expect(codexHookState({ hooksJsonExists: true, configTomlText: 'model = "x"\n', hooksJsonPath: P })).toBe('installed-untrusted');
  });
  it('装了且 config 有引用该 hooks.json 的 trusted_hash → trusted', () => {
    const toml = `[hooks.state."${P}:pre_tool_use:0:0"]\ntrusted_hash = "abc123"\n`;
    expect(codexHookState({ hooksJsonExists: true, configTomlText: toml, hooksJsonPath: P })).toBe('installed-trusted');
  });
  it('config 有别的 hook trust 但不引用本 hooks.json → 仍 untrusted', () => {
    const toml = `[hooks.state."/other/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "z"\n`;
    expect(codexHookState({ hooksJsonExists: true, configTomlText: toml, hooksJsonPath: P })).toBe('installed-untrusted');
  });
});
