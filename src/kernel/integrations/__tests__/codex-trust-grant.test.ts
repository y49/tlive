import { describe, it, expect } from 'vitest';
import { listCodexHooks, type AppServerTransport } from '../codex-trust-grant';

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
