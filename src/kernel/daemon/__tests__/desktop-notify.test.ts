import { describe, it, expect, vi } from 'vitest';
import { createDesktopNotifier } from '../desktop-notify';

describe('createDesktopNotifier', () => {
  const linux = { platform: 'linux' as const, hasCmd: () => true };

  it('pings notify-send with app name, expiry, and the transient hint (expired toasts must evaporate, not archive into the tray)', async () => {
    const spawner = vi.fn(async () => '1');
    const n = createDesktopNotifier({ ...linux, spawner });
    await n.ping('tlive · Bash', 'Waiting for approval');
    expect(spawner).toHaveBeenCalledOnce();
    const [cmd, args] = spawner.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('notify-send');
    expect(args).toContain('--app-name=tlive');
    expect(args).toContain('--hint=int:transient:1');
    expect(args).toContain('tlive · Bash');
    expect(args).toContain('Waiting for approval');
  });

  it('occupies a single notification slot: second ping replaces the first (--replace-id)', async () => {
    const spawner = vi.fn(async () => '42\n');
    const n = createDesktopNotifier({ ...linux, spawner });
    await n.ping('a', 'b');
    await n.ping('c', 'd');
    const first = spawner.mock.calls[0][1] as string[];
    const second = spawner.mock.calls[1][1] as string[];
    expect(first).toContain('--print-id');
    expect(first.some((a) => a.startsWith('--replace-id='))).toBe(false);
    expect(second).toContain('--replace-id=42');
  });

  it('a burst is serialized so every ping after the first replaces the same slot', async () => {
    let resolveFirst: (v: string) => void;
    const outputs = [new Promise<string>((r) => { resolveFirst = r; }), Promise.resolve('7')];
    const spawner = vi.fn(() => outputs[Math.min(spawner.mock.calls.length - 1, 1)]);
    const n = createDesktopNotifier({ ...linux, spawner });
    void n.ping('a', 'b');
    const p2 = n.ping('c', 'd'); // fired before first id is back
    await new Promise((r) => setImmediate(r)); // flush microtasks; first send starts
    expect(spawner).toHaveBeenCalledTimes(1); // second is queued, not raced
    resolveFirst!('7');
    await p2;
    expect((spawner.mock.calls[1][1] as string[])).toContain('--replace-id=7');
  });

  it('clear() closes the live notification over DBus and forgets the id', async () => {
    const spawner = vi.fn(async () => '9');
    const n = createDesktopNotifier({ ...linux, spawner });
    await n.ping('a', 'b');
    await n.clear();
    const [cmd, args] = spawner.mock.calls[1] as unknown as [string, string[]];
    expect(cmd).toBe('gdbus');
    expect(args).toContain('org.freedesktop.Notifications.CloseNotification');
    expect(args).toContain('9');
    // Next ping starts a fresh slot — no --replace-id pointing at a closed toast.
    await n.ping('c', 'd');
    expect((spawner.mock.calls[2][1] as string[]).some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('clear() with nothing live is a no-op', async () => {
    const spawner = vi.fn(async () => '1');
    const n = createDesktopNotifier({ ...linux, spawner });
    await n.clear();
    expect(spawner).not.toHaveBeenCalled();
  });

  it('keeps working (without replace) when notify-send prints no id', async () => {
    const spawner = vi.fn(async () => '');
    const n = createDesktopNotifier({ ...linux, spawner });
    await n.ping('a', 'b');
    await n.ping('c', 'd');
    expect((spawner.mock.calls[1][1] as string[]).some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('is a silent no-op when disabled', async () => {
    const spawner = vi.fn(async () => '1');
    const n = createDesktopNotifier({ ...linux, enabled: false, spawner });
    await n.ping('t', 'b');
    await n.clear();
    expect(spawner).not.toHaveBeenCalled();
  });

  it('is a silent no-op off linux', async () => {
    const spawner = vi.fn(async () => '1');
    await createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, spawner }).ping('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('is a silent no-op when notify-send is absent', async () => {
    const spawner = vi.fn(async () => '1');
    await createDesktopNotifier({ platform: 'linux', hasCmd: () => false, spawner }).ping('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });
});
