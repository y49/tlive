// tests/workspace/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from '../../src/workspace/manager.js';

describe('WorkspaceManager — chat-instance model (v2)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tlive-wm-'));
    path = join(dir, 'workspaces.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('create + bindChat creates a ChatInstance and persists v2 schema', async () => {
    const wm = new WorkspaceManager({ persistPath: path });
    const ws = wm.create({ name: 'a', workdir: '/tmp/a' });
    wm.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'tg-1' });
    await wm.save();

    const inst = wm.findChatInstance('telegram', 'tg-1');
    expect(inst).toMatchObject({ workspaceId: ws.id, activeSessionId: null });
    expect(inst!.costRollup).toMatchObject({ totalUsd: 0, sessionCount: 0 });

    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.chatInstances).toHaveLength(1);
    expect(onDisk.workspaces).toHaveLength(1);
  });

  it('bindChat refuses second bind on same (channel, chat) until unbindChat', () => {
    const wm = new WorkspaceManager();
    const a = wm.create({ name: 'a', workdir: '/tmp/a' });
    const b = wm.create({ name: 'b', workdir: '/tmp/b' });
    wm.bindChat({ workspaceId: a.id, channelType: 'telegram', chatId: 'tg-1' });
    expect(() => wm.bindChat({ workspaceId: b.id, channelType: 'telegram', chatId: 'tg-1' }))
      .toThrow(/already bound/);
  });

  it('unbindChat removes the chat instance', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'a', workdir: '/tmp/a' });
    wm.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'tg-1' });
    wm.unbindChat('telegram', 'tg-1');
    expect(wm.findChatInstance('telegram', 'tg-1')).toBeUndefined();
  });

  it('switchChat replaces workspace + resets costRollup + clears activeSessionId', () => {
    const wm = new WorkspaceManager();
    const a = wm.create({ name: 'a', workdir: '/tmp/a' });
    const b = wm.create({ name: 'b', workdir: '/tmp/b' });
    wm.bindChat({ workspaceId: a.id, channelType: 'telegram', chatId: 'tg-1' });
    wm.bindActiveSession('telegram', 'tg-1', 'sid-1');
    wm.addCost('telegram', 'tg-1', 1.5, true);

    wm.switchChat('telegram', 'tg-1', b.id);
    const inst = wm.findChatInstance('telegram', 'tg-1');
    expect(inst!.workspaceId).toBe(b.id);
    expect(inst!.activeSessionId).toBeNull();
    expect(inst!.costRollup.totalUsd).toBe(0);
    expect(inst!.costRollup.sessionCount).toBe(0);
  });

  it('removeWorkspace without --force refuses if any chat is bound', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'a', workdir: '/tmp/a' });
    wm.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'tg-1' });
    expect(() => wm.removeWorkspace(ws.id))
      .toThrow(/1 chat\(s\) still bound/);
    expect(wm.get(ws.id)).toBeDefined();
  });

  it('removeWorkspace with --force cascades chat instance removal', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'a', workdir: '/tmp/a' });
    wm.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'tg-1' });
    wm.bindChat({ workspaceId: ws.id, channelType: 'feishu', chatId: 'fs-x' });
    const removed = wm.removeWorkspace(ws.id, { force: true });
    expect(removed.chatInstances).toHaveLength(2);
    expect(wm.get(ws.id)).toBeUndefined();
    expect(wm.findChatInstance('telegram', 'tg-1')).toBeUndefined();
  });

  it('listChatInstances returns all instances flat', () => {
    const wm = new WorkspaceManager();
    const a = wm.create({ name: 'a', workdir: '/tmp/a' });
    const b = wm.create({ name: 'b', workdir: '/tmp/b' });
    wm.bindChat({ workspaceId: a.id, channelType: 'telegram', chatId: 'tg-1' });
    wm.bindChat({ workspaceId: b.id, channelType: 'feishu', chatId: 'fs-x' });
    expect(wm.listChatInstances()).toHaveLength(2);
  });

  it('addCost accumulates totalUsd; sessionEnded bumps sessionCount', () => {
    const wm = new WorkspaceManager();
    const ws = wm.create({ name: 'a', workdir: '/tmp/a' });
    wm.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'tg-1' });
    wm.addCost('telegram', 'tg-1', 0.5, false);
    wm.addCost('telegram', 'tg-1', 0.7, true);
    const inst = wm.findChatInstance('telegram', 'tg-1');
    expect(inst!.costRollup.totalUsd).toBeCloseTo(1.2, 5);
    expect(inst!.costRollup.sessionCount).toBe(1);
  });

  it('load v2 file rehydrates Map + chatInstances', async () => {
    const wm1 = new WorkspaceManager({ persistPath: path });
    const ws = wm1.create({ name: 'a', workdir: '/tmp/a' });
    wm1.bindChat({ workspaceId: ws.id, channelType: 'telegram', chatId: 'tg-1' });
    await wm1.save();

    const wm2 = new WorkspaceManager({ persistPath: path });
    await wm2.load();
    expect(wm2.list()).toHaveLength(1);
    expect(wm2.findChatInstance('telegram', 'tg-1')).toBeDefined();
  });

  it('load v1 file (legacy) is rejected with explicit error — no migration', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, JSON.stringify({ version: 1, workspaces: [] }));
    const wm = new WorkspaceManager({ persistPath: path });
    await expect(wm.load()).rejects.toThrow(/schema version 1 unsupported/);
  });
});
