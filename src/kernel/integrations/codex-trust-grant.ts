// Codex trust 自动化:经 `codex app-server` 的官方只读 RPC `hooks/list` 拿每个
// hook 的 key + currentHash,供后续把 tlive 自己 hooks 的 trusted_hash 写进
// ~/.codex/config.toml 的 [hooks.state](与 TUI approve 落盘产物等价)使用。
// 任何失败 = 安全失败(不写/回滚),setup 降级为 `/hooks` 引导。
// 只触碰 key 以 `tlive@tlive:` 开头的段 —— 绝不放宽其他 hook 的信任。
import { spawn } from 'node:child_process';

export interface CodexHookMeta { key: string; currentHash: string; trustStatus: string; enabled: boolean }

export type AppServerTransport = () => {
  send: (line: string) => void;
  onLine: (cb: (line: string) => void) => void;
  kill: () => void;
};

export const defaultTransport: AppServerTransport = () => {
  const p = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  let cb: (line: string) => void = () => {};
  p.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf-8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) cb(line);
    }
  });
  return {
    send: (line) => p.stdin.write(line + '\n'),
    onLine: (fn) => { cb = fn; },
    kill: () => { try { p.kill(); } catch { /* already dead */ } },
  };
};

export function listCodexHooks(transport: AppServerTransport = defaultTransport, timeoutMs = 15_000): Promise<CodexHookMeta[]> {
  return new Promise((resolve, reject) => {
    const conn = transport();
    const timer = setTimeout(() => { conn.kill(); reject(new Error('codex app-server timeout')); }, timeoutMs);
    timer.unref?.();
    const done = (fn: () => void): void => { clearTimeout(timer); conn.kill(); fn(); };
    conn.onLine((line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        conn.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [] } }));
      } else if (msg.id === 2) {
        if (msg.error) return done(() => reject(new Error(`hooks/list error: ${JSON.stringify(msg.error).slice(0, 200)}`)));
        const hooks: CodexHookMeta[] = (msg.result?.data ?? []).flatMap((e: any) => e.hooks ?? [])
          .map((h: any) => ({ key: String(h.key), currentHash: String(h.currentHash), trustStatus: String(h.trustStatus), enabled: h.enabled !== false }));
        done(() => resolve(hooks));
      }
    });
    conn.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'tlive', title: 'tlive', version: '2.0.0' }, capabilities: { experimentalApi: true } },
    }));
  });
}
