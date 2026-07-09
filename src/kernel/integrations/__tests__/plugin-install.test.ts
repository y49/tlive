import { describe, it, expect } from 'vitest';
import { installClaudePlugin, installCodexPlugin, claudePluginDir, codexPluginDir, type Runner } from '../plugin-install';

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

describe('installClaudePlugin', () => {
  it('探测→marketplace add→install 顺序,全 ok', () => {
    const { run, calls } = scripted([
      { match: /^claude plugin list$/, ok: true },
      { match: /^claude plugin marketplace add /, ok: true },
      { match: /^claude plugin install tlive@tlive --scope user -y$/, ok: true },
    ]);
    expect(installClaudePlugin(run).ok).toBe(true);
    expect(calls[0]).toBe('claude plugin list');
    expect(calls[1]).toContain(claudePluginDir());
    expect(calls[2]).toBe('claude plugin install tlive@tlive --scope user -y');
  });
  it('探测失败(老版本)→ ok:false,不再跑后续', () => {
    const { run, calls } = scripted([{ match: /list/, ok: false }]);
    expect(installClaudePlugin(run).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
  it('marketplace add 输出 already 视为成功继续', () => {
    const { run } = scripted([
      { match: /list/, ok: true },
      { match: /marketplace add/, ok: false, output: 'Error: marketplace "tlive" already exists' },
      { match: /plugin install/, ok: true },
    ]);
    expect(installClaudePlugin(run).ok).toBe(true);
  });
});

describe('installCodexPlugin', () => {
  it('codex 缺 → ok:false 零调用命令', () => {
    const { run, calls } = scripted([]);
    expect(installCodexPlugin(run, () => false).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('全 ok 序列', () => {
    const { run, calls } = scripted([
      { match: /^codex plugin marketplace add /, ok: true },
      { match: /^codex plugin add tlive@tlive$/, ok: true },
    ]);
    expect(installCodexPlugin(run, () => true).ok).toBe(true);
    expect(calls[0]).toContain(codexPluginDir());
  });
});
