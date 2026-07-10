// Codex trust 自动化:经 `codex app-server` 的官方只读 RPC `hooks/list` 拿每个
// hook 的 key + currentHash,供后续把 tlive 自己 hooks 的 trusted_hash 写进
// ~/.codex/config.toml 的 [hooks.state](与 TUI approve 落盘产物等价)使用。
// 任何失败 = 安全失败(不写/回滚),setup 降级为 `/hooks` 引导。
// 只触碰 key 以 `tlive@tlive:` 开头的段 —— 绝不放宽其他 hook 的信任。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexHookMeta { key: string; currentHash: string; trustStatus: string; enabled: boolean }

export type AppServerTransport = () => {
  send: (line: string) => void;
  onLine: (cb: (line: string) => void) => void;
  kill: () => void;
};

/** spawn 一个命令作为 app-server transport。导出供测试注入失败命令。 */
export const spawnTransport = (cmd: string, args: string[]): ReturnType<AppServerTransport> => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  // 无 'error' 监听的 EventEmitter 抛未捕获异常(spawn ENOENT / 老版本 codex 无
  // app-server 子命令时 stdin EPIPE)—— 会绕过所有 try/catch 炸掉 setup。吞掉:
  // 上层靠超时 reject 走安全降级(/hooks 引导)。
  p.on('error', () => { /* handled via timeout */ });
  p.stdin.on('error', () => { /* EPIPE on exiting child */ });
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
    send: (line) => { try { p.stdin.write(line + '\n'); } catch { /* child gone */ } },
    onLine: (fn) => { cb = fn; },
    kill: () => { try { p.kill(); } catch { /* already dead */ } },
  };
};

export const defaultTransport: AppServerTransport = () => spawnTransport('codex', ['app-server']);

export function listCodexHooks(transport: AppServerTransport = defaultTransport, timeoutMs = 15_000): Promise<CodexHookMeta[]> {
  return new Promise((resolve, reject) => {
    const conn = transport();
    const timer = setTimeout(() => { conn.kill(); reject(new Error('codex app-server timeout')); }, timeoutMs);
    timer.unref?.();
    let settled = false;
    const done = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); conn.kill(); fn(); };
    conn.onLine((line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 1) {
        if (msg.error) return done(() => reject(new Error(`initialize error: ${JSON.stringify(msg.error).slice(0, 200)}`)));
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

const TLIVE_KEY_PREFIX = 'tlive@tlive:';

/** upsert 一个 [hooks.state."<key>"] 段:已有则整段替换,没有则文末 append。
 *  段边界 = 该 header 到下一个 section header(或 EOF)。只处理精确 header 匹配。 */
function upsertStateSection(toml: string, key: string, hash: string): string {
  const header = `[hooks.state."${key}"]`;
  const body = `${header}\ntrusted_hash = "${hash}"\nenabled = true\n`;
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    const sep = toml.endsWith('\n') || toml === '' ? '' : '\n';
    return `${toml}${sep}\n${body}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  // 段尾的空行/纯注释行属于下一个 section(用户给它的注释),回退保留。
  while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
  return [...lines.slice(0, start), ...body.trimEnd().split('\n'), ...lines.slice(end)].join('\n');
}

export async function grantCodexTrust(opts?: {
  list?: () => Promise<CodexHookMeta[]>;
  codexHome?: string;
}): Promise<{ granted: number; verified: boolean; detail: string }> {
  const list = opts?.list ?? (() => listCodexHooks());
  const codexHome = opts?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const configPath = join(codexHome, 'config.toml');
  let backup: string | null = null;
  try {
    const mine = (await list()).filter((h) => h.key.startsWith(TLIVE_KEY_PREFIX));
    if (mine.length === 0) return { granted: 0, verified: false, detail: 'no tlive hooks visible to codex' };
    const pending = mine.filter((h) => h.trustStatus !== 'trusted' && h.trustStatus !== 'managed');
    if (pending.length === 0) return { granted: 0, verified: true, detail: 'already trusted' };
    if (!existsSync(configPath)) return { granted: 0, verified: false, detail: 'no ~/.codex/config.toml (run codex once first)' };
    backup = readFileSync(configPath, 'utf-8');
    let toml = backup;
    for (const h of pending) toml = upsertStateSection(toml, h.key, h.currentHash);
    writeFileSync(configPath, toml);
    const after = (await list()).filter((h) => h.key.startsWith(TLIVE_KEY_PREFIX));
    const ok = after.length > 0 && after.every((h) => h.trustStatus === 'trusted' || h.trustStatus === 'managed');
    if (!ok) {
      writeFileSync(configPath, backup); // 自检不过:回滚,退回引导路径
      return { granted: 0, verified: false, detail: 'self-check failed, rolled back' };
    }
    return { granted: pending.length, verified: true, detail: `trusted ${pending.length} hook(s)` };
  } catch (e) {
    if (backup !== null) { try { writeFileSync(configPath, backup); } catch { /* keep going */ } }
    return { granted: 0, verified: false, detail: `error: ${(e as Error).message.slice(0, 120)}` };
  }
}
