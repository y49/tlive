import { describe, it, expect, vi } from 'vitest';
import { createDesktopNotifier } from '../desktop-notify';

describe('createDesktopNotifier', () => {
  const linux = { platform: 'linux' as const, hasCmd: () => true };

  it('spawns notify-send with app name and expiry on linux when the binary exists', () => {
    const spawner = vi.fn();
    const notify = createDesktopNotifier({ ...linux, spawner });
    notify('tlive · Bash', 'Waiting for approval');
    expect(spawner).toHaveBeenCalledOnce();
    const [cmd, args] = spawner.mock.calls[0];
    expect(cmd).toBe('notify-send');
    expect(args).toContain('--app-name=tlive');
    expect(args).toContain('tlive · Bash');
    expect(args).toContain('Waiting for approval');
  });

  it('is a silent no-op when disabled', () => {
    const spawner = vi.fn();
    createDesktopNotifier({ ...linux, enabled: false, spawner })('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('is a silent no-op off linux', () => {
    const spawner = vi.fn();
    createDesktopNotifier({ platform: 'darwin', hasCmd: () => true, spawner })('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('is a silent no-op when notify-send is absent', () => {
    const spawner = vi.fn();
    createDesktopNotifier({ platform: 'linux', hasCmd: () => false, spawner })('t', 'b');
    expect(spawner).not.toHaveBeenCalled();
  });
});
