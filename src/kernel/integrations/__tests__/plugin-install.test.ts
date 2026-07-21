import { describe, it, expect } from 'vitest';
import {
  installClaudePlugin, installCodexPlugin, claudePluginDir, codexPluginDir,
  bundledPluginVersion, installedPluginVersion, pluginHealth, winQuote, type Runner,
} from '../plugin-install';

function scripted(responses: Array<{ match: RegExp; ok: boolean; output?: string }>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const r = responses.find((x) => x.match.test(line));
    return { ok: r?.ok ?? false, output: r?.output ?? '' };
  };
  return { run, calls };
}

const CC_VERSION = bundledPluginVersion('claude')!;
const CX_VERSION = bundledPluginVersion('codex')!;

describe('bundledPluginVersion', () => {
  it('reads both bundled manifests', () => {
    expect(CC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CX_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('installedPluginVersion', () => {
  it('parses the claude shape (top-level array of {id, version})', () => {
    const { run } = scripted([
      { match: /plugin list --json/, ok: true, output: JSON.stringify([{ id: 'other@x', version: '1.0.0' }, { id: 'tlive@tlive', version: '2.3.0' }]) },
    ]);
    expect(installedPluginVersion(run, 'claude')).toBe('2.3.0');
  });
  it('parses the codex shape ({installed: [{pluginId, version}]})', () => {
    const { run } = scripted([
      { match: /plugin list --json/, ok: true, output: JSON.stringify({ installed: [{ pluginId: 'tlive@tlive', version: '2.2.0' }] }) },
    ]);
    expect(installedPluginVersion(run, 'codex')).toBe('2.2.0');
  });
  it('degrades to null when --json is unsupported or unparseable', () => {
    expect(installedPluginVersion(scripted([]).run, 'claude')).toBeNull();
    const { run } = scripted([{ match: /--json/, ok: true, output: 'not json' }]);
    expect(installedPluginVersion(run, 'claude')).toBeNull();
  });
});

describe('installClaudePlugin', () => {
  it('探测→marketplace add→update→install 顺序,全 ok', () => {
    const { run, calls } = scripted([
      { match: /^claude plugin list$/, ok: true },
      { match: /^claude plugin marketplace add /, ok: true },
      { match: /^claude plugin marketplace update tlive$/, ok: true },
      { match: /^claude plugin install tlive@tlive --scope user$/, ok: true },
    ]);
    expect(installClaudePlugin(run).ok).toBe(true);
    expect(calls[0]).toBe('claude plugin list');
    expect(calls[1]).toContain(claudePluginDir());
    // marketplace update 强制刷新 source(修"永远停在旧版"),再 install
    expect(calls[2]).toBe('claude plugin marketplace update tlive');
    expect(calls[3]).toBe('claude plugin install tlive@tlive --scope user');
  });
  it('探测失败(老版本)→ ok:false,不再跑后续', () => {
    const { run, calls } = scripted([{ match: /list/, ok: false }]);
    expect(installClaudePlugin(run).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
  it('marketplace add 输出 already 视为成功继续', () => {
    const { run } = scripted([
      { match: /^claude plugin list$/, ok: true },
      { match: /marketplace add/, ok: false, output: 'Error: marketplace "tlive" already exists' },
      { match: /marketplace update/, ok: true },
      { match: /plugin install/, ok: true },
    ]);
    expect(installClaudePlugin(run).ok).toBe(true);
  });
  it('marketplace update 失败不再被吞(否则后续 update 会"成功"更到旧 source)', () => {
    const { run } = scripted([
      { match: /^claude plugin list$/, ok: true },
      { match: /marketplace add/, ok: true },
      { match: /marketplace update/, ok: false, output: 'network error' },
    ]);
    const r = installClaudePlugin(run);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('marketplace update failed');
  });
  it('已装 → plugin update → 版本核验通过,detail 报实际版本', () => {
    const { run, calls } = scripted([
      { match: /^claude plugin list$/, ok: true },
      { match: /marketplace add/, ok: true },
      { match: /marketplace update/, ok: true },
      { match: /plugin install/, ok: false, output: 'already installed' },
      { match: /^claude plugin update tlive@tlive$/, ok: true },
      { match: /plugin list --json/, ok: true, output: JSON.stringify([{ id: 'tlive@tlive', version: CC_VERSION }]) },
    ]);
    const r = installClaudePlugin(run);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain(`refreshed at ${CC_VERSION}`);
    expect(calls).toContain('claude plugin update tlive@tlive');
  });
  it('版本核验:cache 仍是旧版 → ok:false 并指路手动更新(不再静默发旧插件)', () => {
    const { run } = scripted([
      { match: /^claude plugin list$/, ok: true },
      { match: /marketplace add/, ok: true },
      { match: /marketplace update/, ok: true },
      { match: /plugin install/, ok: false, output: 'already installed' },
      { match: /^claude plugin update tlive@tlive$/, ok: true, output: 'already up to date' },
      { match: /plugin list --json/, ok: true, output: JSON.stringify([{ id: 'tlive@tlive', version: '0.0.1' }]) },
    ]);
    const r = installClaudePlugin(run);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('0.0.1');
    expect(r.detail).toContain(CC_VERSION);
  });
  it('老 CLI 无 --json → 核验优雅降级为不可验,不失败', () => {
    const { run } = scripted([
      { match: /^claude plugin list$/, ok: true },
      { match: /marketplace add/, ok: true },
      { match: /marketplace update/, ok: true },
      { match: /plugin install/, ok: true },
    ]);
    const r = installClaudePlugin(run);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('unverifiable');
  });
});

describe('pluginHealth', () => {
  it('vendor missing → null (nothing to report)', () => {
    expect(pluginHealth('claude', scripted([]).run, () => false)).toBeNull();
  });
  it('list parses fine but tlive absent → NOT INSTALLED warning (the 3-day silent-loss incident)', () => {
    const { run } = scripted([
      { match: /plugin list --json/, ok: true, output: JSON.stringify([{ id: 'other@x', version: '1.0.0' }]) },
    ]);
    const line = pluginHealth('claude', run, () => true)!;
    expect(line).toContain('NOT INSTALLED');
    expect(line).toContain('hooks inactive');
  });
  it('old CLI without --json → unverifiable, NOT a false "not installed" alarm', () => {
    const line = pluginHealth('claude', scripted([]).run, () => true)!;
    expect(line).toContain('unverifiable');
    expect(line).not.toContain('NOT INSTALLED');
  });
  it('version mismatch → points at setup --hooks-only', () => {
    const { run } = scripted([
      { match: /plugin list --json/, ok: true, output: JSON.stringify([{ id: 'tlive@tlive', version: '0.0.1' }]) },
    ]);
    const line = pluginHealth('claude', run, () => true)!;
    expect(line).toContain('0.0.1');
    expect(line).toContain(CC_VERSION);
  });
  it('healthy → version with a checkmark', () => {
    const { run } = scripted([
      { match: /plugin list --json/, ok: true, output: JSON.stringify({ installed: [{ pluginId: 'tlive@tlive', version: CX_VERSION }] }) },
    ]);
    expect(pluginHealth('codex', run, () => true)).toBe(`codex: plugin ${CX_VERSION} ✓`);
  });
});

describe('installCodexPlugin', () => {
  it('codex 缺 → ok:false 零调用命令', () => {
    const { run, calls } = scripted([]);
    expect(installCodexPlugin(run, () => false).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('全 ok 序列(add 即 upsert,重跑就是刷新)', () => {
    const { run, calls } = scripted([
      { match: /^codex plugin marketplace add /, ok: true },
      { match: /^codex plugin add tlive@tlive$/, ok: true },
    ]);
    expect(installCodexPlugin(run, () => true).ok).toBe(true);
    expect(calls[0]).toContain(codexPluginDir());
    expect(calls[1]).toBe('codex plugin add tlive@tlive');
  });
  it('已注册 marketplace + add 后核验版本,旧版 → ok:false', () => {
    const { run } = scripted([
      { match: /marketplace add/, ok: false, output: 'already exists' },
      { match: /^codex plugin add tlive@tlive$/, ok: true },
      { match: /plugin list --json/, ok: true, output: JSON.stringify({ installed: [{ pluginId: 'tlive@tlive', version: '0.0.1' }] }) },
    ]);
    const r = installCodexPlugin(run, () => true);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('0.0.1');
    expect(r.detail).toContain(CX_VERSION);
  });
  it('核验一致 → detail 报 refreshed at <version>', () => {
    const { run } = scripted([
      { match: /marketplace add/, ok: false, output: 'already exists' },
      { match: /^codex plugin add tlive@tlive$/, ok: true },
      { match: /plugin list --json/, ok: true, output: JSON.stringify({ installed: [{ pluginId: 'tlive@tlive', version: CX_VERSION }] }) },
    ]);
    const r = installCodexPlugin(run, () => true);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain(`refreshed at ${CX_VERSION}`);
  });
});

describe('winQuote (cmd.exe argument quoting for the win32 shell runner)', () => {
  it('leaves plain args untouched', () => {
    expect(winQuote('plugin')).toBe('plugin');
    expect(winQuote('tlive@tlive')).toBe('tlive@tlive');
  });
  it('quotes paths with spaces', () => {
    expect(winQuote('C:\\Users\\John Doe\\.tlive')).toBe('"C:\\Users\\John Doe\\.tlive"');
  });
  it('doubles embedded double quotes (cmd escape)', () => {
    expect(winQuote('a "b" c')).toBe('"a ""b"" c"');
  });
});
