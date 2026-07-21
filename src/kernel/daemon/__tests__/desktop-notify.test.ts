import { describe, it, expect, vi } from 'vitest';
import { createDesktopNotifier } from '../desktop-notify';

describe('createDesktopNotifier', () => {
  const linux = { platform: 'linux' as const, hasCmd: () => true };

  it('spawns notify-send with app name and expiry on linux when the binary exists', async () => {
    const spawner = vi.fn(async () => '1');
    const notify = createDesktopNotifier({ ...linux, spawner });
    await notify('tlive · Bash', 'Waiting for approval');
    expect(spawner).toHaveBeenCalledOnce();
    const [cmd, args] = spawner.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('notify-send');
    expect(args).toContain('--app-name=tlive');
    expect(args).toContain('tlive · Bash');
    expect(args).toContain('Waiting for approval');
  });

  it('occupies a single notification slot: second send replaces the first (--replace-id)', async () => {
    const spawner = vi.fn(async () => '42\n');
    const notify = createDesktopNotifier({ ...linux, spawner });
    await notify('a', 'b');
    await notify('c', 'd');
    const first = spawner.mock.calls[0][1] as string[];
    const second = spawner.mock.calls[1][1] as string[];
    expect(first).toContain('--print-id');
    expect(first.some((a) => a.startsWith('--replace-id='))).toBe(false);
    expect(second).toContain('--replace-id=42');
  });

  it('a burst is serialized so every send after the first replaces the same slot', async () => {
    let resolveFirst: (v: string) => void;
    const outputs = [new Promise<string>((r) => { resolveFirst = r; }), Promise.resolve('7')];
    const spawner = vi.fn(() => outputs[Math.min(spawner.mock.calls.length - 1, 1)]);
    const notify = createDesktopNotifier({ ...linux, spawner });
    void notify('a', 'b');
    const p2 = notify('c', 'd'); // fired before first id is back
    await new Promise((r) => setImmediate(r)); // flush microtasks; first send starts
    expect(spawner).toHaveBeenCalledTimes(1); // second is queued, not raced
    resolveFirst!('7');
    await p2;
    expect((spawner.mock.calls[1][1] as string[])).toContain('--replace-id=7');
  });

  it('keeps working (without replace) when notify-send prints no id', async () => {
    const spawner = vi.fn(async () => '');
    const notify = createDesktopNotifier({ ...linux, spawner });
    await notify('a', 'b');
    await notify('c', 'd');
    expect((spawner.mock.calls[1][1] as string[]).some((a) => a.startsWith('--replace-id='))).toBe(false);
  });

  it('is a silent no-op when disabled', async () => {
    const spawner = vi.fn(async () => '1');
    await createDesktopNotifier({ ...linux, enabled: false, spawner })('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('is a silent no-op off linux', async () => {
    const spawner = vi.fn(async () => '1');
    await createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, spawner })('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('is a silent no-op when notify-send is absent', async () => {
    const spawner = vi.fn(async () => '1');
    await createDesktopNotifier({ platform: 'linux', hasCmd: () => false, spawner })('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });
});
