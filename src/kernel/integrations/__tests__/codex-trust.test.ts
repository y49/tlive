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
  it('本路径 hooks.state 段无 trusted_hash,后续无关段有 trusted_hash → 仍 untrusted', () => {
    const toml = [
      `[hooks.state."${P}:pre_tool_use:0:0"]`,
      `some_unrelated_field = "x"`,
      ``,
      `[some_other_tool_config]`,
      `trusted_hash = "belongs-to-something-else"`,
    ].join('\n');
    expect(codexHookState({ hooksJsonExists: true, configTomlText: toml, hooksJsonPath: P })).toBe('installed-untrusted');
  });
});

describe('codexHookState — 插件模式 trust key(tlive@tlive:…,不含绝对路径)', () => {
  it('插件 key 段带 trusted_hash → trusted(即使不含 cache 路径)', () => {
    const toml = `[hooks.state."tlive@tlive:hooks/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`;
    expect(codexHookState({ hooksJsonExists: true, configTomlText: toml, hooksJsonPath: P })).toBe('installed-trusted');
  });
  it('别的插件的 key → 仍 untrusted', () => {
    const toml = `[hooks.state."other@mk:hooks/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:z"\n`;
    expect(codexHookState({ hooksJsonExists: true, configTomlText: toml, hooksJsonPath: P })).toBe('installed-untrusted');
  });
});
