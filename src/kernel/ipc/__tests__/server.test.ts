import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { startIpcServer, type IpcServer } from '../server';
import { request } from '../client';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

const mkSock = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tlive-ipc-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'x.sock');
};

describe('IpcCallContext.onDisconnect', () => {
  it('fires when the caller disconnects while the handler is still pending', async () => {
    const path = mkSock();
    let fired = false;
    const srv: IpcServer = await startIpcServer({
      path,
      handler: (_req, _reply, ctx) => {
        ctx.onDisconnect?.(() => { fired = true; });
        return new Promise<void>(() => {}); // never resolves — simulates a pending approval
      },
    });
    cleanup.push(() => void srv.close());

    // Send one request, then disconnect immediately (simulates the shim process dying).
    await new Promise<void>((resolve) => {
      const sock = createConnection(path, () => {
        sock.write(JSON.stringify({ kind: 'daemon.status' }) + '\n');
        setTimeout(() => { sock.destroy(); resolve(); }, 30);
      });
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(true);
  });

  it('does not fire synchronously when registered, before any disconnect has occurred', async () => {
    const path = mkSock();
    let fired = false;
    const srv: IpcServer = await startIpcServer({
      path,
      handler: (_req, reply, ctx) => {
        ctx.onDisconnect?.(() => { fired = true; });
        reply({ kind: 'ack' });
      },
    });
    cleanup.push(() => void srv.close());
    await request({ kind: 'daemon.status' }, { socketPath: path, timeoutMs: 1000 }).catch(() => undefined);
    // 这里只证明"注册那一刻/回复那一刻"没有同步触发 —— client 的 request() 在拿到
    // reply 后才调用 sock.end(),此刻 FIN 还没跑到 server,'close' 事件必然还没发生。
    // 这不代表 close 事件抵达后也不会触发(那是下面一条测试验证的真实契约):见
    // "DOES fire..."。
    expect(fired).toBe(false);
  });

  it('DOES fire after the caller disconnects, even following a completely normal reply', async () => {
    const path = mkSock();
    let disconnected!: () => void;
    const disconnectPromise = new Promise<void>((resolve) => { disconnected = resolve; });
    const srv: IpcServer = await startIpcServer({
      path,
      handler: (_req, reply, ctx) => {
        ctx.onDisconnect?.(() => disconnected());
        reply({ kind: 'ack' });
      },
    });
    cleanup.push(() => void srv.close());

    // 完全正常的一问一答:client 拿到 reply 后自己关闭 socket —— 不是异常死亡。
    await request({ kind: 'daemon.status' }, { socketPath: path, timeoutMs: 1000 }).catch(() => undefined);

    // 即便如此,一旦 close 事件抵达 server,onDisconnect 依然会触发。这就是全部
    // 契约的核心:disconnect 信号本身无法区分"shim 异常死亡"和"shim 拿到答案后
    // 正常关闭"—— 两者在 socket 层面都只是一次 close。因此 Task 3 的消费者绝不能
    // 仅凭"收到了 disconnect"就判定异常死亡,必须额外检查 pending.has(requestId):
    // 如果已经在 answer()/cancel() 里删掉了,说明这是正常完成后的关闭,不该再动它。
    // 用真实 close 事件驱动断言,而不是猜一个 setTimeout —— 避免计时侥幸。
    await disconnectPromise;
  });
});
