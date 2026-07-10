import { describe, it, expect, afterEach } from 'vitest';
import { listCodexHooks, grantCodexTrust, type AppServerTransport } from '../codex-trust-grant';
import { mkdtempSync, writeFileSync as wf, readFileSync as rf, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 脚本化 transport:按收到的请求 id 回放响应行。 */
function scripted(hooks: object[]): { transport: AppServerTransport; sent: string[]; killed: () => boolean } {
  const sent: string[] = [];
  let dead = false;
  let deliver: (line: string) => void = () => {};
  const transport: AppServerTransport = () => ({
    send: (line) => {
      sent.push(line);
      const req = JSON.parse(line);
      if (req.method === 'initialize') setImmediate(() => deliver(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })));
      if (req.method === 'hooks/list') setImmediate(() => deliver(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { data: [{ cwd: '/x', hooks, warnings: [], errors: [] }] } })));
    },
    onLine: (cb) => { deliver = cb; },
    kill: () => { dead = true; },
  });
  return { transport, sent, killed: () => dead };
}

const HOOK = (event: string, status = 'untrusted') => ({
  key: `tlive@tlive:hooks/hooks.json:${event}:0:0`,
  currentHash: `sha256:hash-${event}`,
  trustStatus: status,
  enabled: true,
  eventName: event,
});

describe('listCodexHooks', () => {
  it('initialize→hooks/list 握手,解析 key/currentHash/trustStatus', async () => {
    const { transport, sent, killed } = scripted([HOOK('pre_tool_use'), HOOK('stop', 'trusted')]);
    const hooks = await listCodexHooks(transport);
    expect(JSON.parse(sent[0]).method).toBe('initialize');
    expect(JSON.parse(sent[0]).params.capabilities.experimentalApi).toBe(true);
    expect(JSON.parse(sent[1]).method).toBe('hooks/list');
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toMatchObject({ key: 'tlive@tlive:hooks/hooks.json:pre_tool_use:0:0', currentHash: 'sha256:hash-pre_tool_use', trustStatus: 'untrusted' });
    expect(killed()).toBe(true); // 完成后清理进程
  });
  it('超时 → reject 且 kill', async () => {
    let dead = false;
    const t: AppServerTransport = () => ({ send: () => {}, onLine: () => {}, kill: () => { dead = true; } });
    await expect(listCodexHooks(t, 100)).rejects.toThrow();
    expect(dead).toBe(true);
  });
});

describe('grantCodexTrust', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const homeWith = (toml: string | null): string => {
    const d = mkdtempSync(join(tmpdir(), 'tlive-grant-')); dirs.push(d);
    if (toml !== null) wf(join(d, 'config.toml'), toml);
    return d;
  };
  const seq = (...results: object[][]) => { let i = 0; return () => Promise.resolve(results[Math.min(i++, results.length - 1)] as any); };

  it('untrusted → 写段 → 自检 trusted → verified:true,原内容保留', async () => {
    const home = homeWith('model = "gpt-5.5"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
    const r = await grantCodexTrust({ codexHome: home, list: seq(
      [HOOK('pre_tool_use'), HOOK('stop')],                         // 写前:untrusted
      [HOOK('pre_tool_use', 'trusted'), HOOK('stop', 'trusted')],   // 自检:trusted
    ) });
    expect(r).toMatchObject({ granted: 2, verified: true });
    const toml = rf(join(home, 'config.toml'), 'utf-8');
    expect(toml).toContain('model = "gpt-5.5"');                    // 原内容不动
    expect(toml).toContain('[hooks.state."tlive@tlive:hooks/hooks.json:pre_tool_use:0:0"]');
    expect(toml).toContain('trusted_hash = "sha256:hash-pre_tool_use"');
    expect(toml).toContain('enabled = true');
  });
  it('自检仍 untrusted → 回滚原文 → verified:false', async () => {
    const orig = 'model = "gpt-5.5"\n';
    const home = homeWith(orig);
    const r = await grantCodexTrust({ codexHome: home, list: seq(
      [HOOK('pre_tool_use')],
      [HOOK('pre_tool_use', 'untrusted')],   // 自检失败
    ) });
    expect(r.verified).toBe(false);
    expect(rf(join(home, 'config.toml'), 'utf-8')).toBe(orig);      // 回滚
  });
  it('已全 trusted → 不写文件,verified:true', async () => {
    const orig = '# untouched\n';
    const home = homeWith(orig);
    const r = await grantCodexTrust({ codexHome: home, list: seq([HOOK('a', 'trusted')]) });
    expect(r).toMatchObject({ granted: 0, verified: true });
    expect(rf(join(home, 'config.toml'), 'utf-8')).toBe(orig);
  });
  it('已有同 key 段(旧 hash)→ 更新该段 trusted_hash 而非重复 append', async () => {
    const key = 'tlive@tlive:hooks/hooks.json:pre_tool_use:0:0';
    const home = homeWith(`[hooks.state."${key}"]\ntrusted_hash = "sha256:OLD"\nenabled = true\n`);
    const r = await grantCodexTrust({ codexHome: home, list: seq(
      [HOOK('pre_tool_use')],
      [HOOK('pre_tool_use', 'trusted')],
    ) });
    expect(r.verified).toBe(true);
    const toml = rf(join(home, 'config.toml'), 'utf-8');
    expect(toml).toContain('sha256:hash-pre_tool_use');
    expect(toml).not.toContain('sha256:OLD');
    expect(toml.match(new RegExp('hooks\\.state\\."tlive@tlive', 'g'))!.length).toBe(1); // 无重复段
  });
  it('config.toml 不存在 → 安全退出 verified:false 不创建文件', async () => {
    const home = homeWith(null);
    const r = await grantCodexTrust({ codexHome: home, list: seq([HOOK('a')]) });
    expect(r.verified).toBe(false);
    expect(existsSync(join(home, 'config.toml'))).toBe(false);
  });
  it('list 抛异常 → verified:false(安全失败)', async () => {
    const home = homeWith('x = 1\n');
    const r = await grantCodexTrust({ codexHome: home, list: () => Promise.reject(new Error('down')) });
    expect(r.verified).toBe(false);
    expect(rf(join(home, 'config.toml'), 'utf-8')).toBe('x = 1\n');
  });
  it('替换段时保留下一段前的空行与用户注释', async () => {
    const key = 'tlive@tlive:hooks/hooks.json:pre_tool_use:0:0';
    const home = homeWith([
      `[hooks.state."${key}"]`,
      'trusted_hash = "sha256:OLD"',
      'enabled = true',
      '',
      '# 用户给 other hook 的备注',
      '[hooks.state."other@x:hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:theirs"',
      '',
    ].join('\n'));
    const r = await grantCodexTrust({ codexHome: home, list: seq(
      [HOOK('pre_tool_use')],
      [HOOK('pre_tool_use', 'trusted')],
    ) });
    expect(r.verified).toBe(true);
    const toml = rf(join(home, 'config.toml'), 'utf-8');
    expect(toml).toContain('# 用户给 other hook 的备注');
    expect(toml).toContain('sha256:theirs');           // 别人的段原样
    expect(toml).toContain('sha256:hash-pre_tool_use'); // 我们的段已更新
    expect(toml).not.toContain('sha256:OLD');
  });
});

describe('transport 失败韧性(终审回归)', () => {
  it('spawn 不存在的二进制 → listCodexHooks 超时 reject,无未捕获异常', async () => {
    const { spawnTransport } = await import('../codex-trust-grant');
    await expect(
      listCodexHooks(() => spawnTransport('tlive-definitely-no-such-binary-xyz', []), 800),
    ).rejects.toThrow(/timeout/);
  });
  it('grantCodexTrust 面对失败 transport → verified:false 安全降级不崩', async () => {
    const { spawnTransport } = await import('../codex-trust-grant');
    const home = (() => { const d = mkdtempSync(join(tmpdir(), 'tlive-tf-')); return d; })();
    try {
      const r = await grantCodexTrust({
        codexHome: home,
        list: () => listCodexHooks(() => spawnTransport('tlive-definitely-no-such-binary-xyz', []), 800),
      });
      expect(r.verified).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
