import { describe, it, expect } from 'vitest';
import { TelegramHudPanel } from '../../../src/im/hud/telegram-panel.js';
import { FeishuHudPanel } from '../../../src/im/hud/feishu-panel.js';
import { initialHudState } from '../../../src/im/hud/state.js';
import { FakeAdapter } from '../fake-adapter.js';

describe('HUD cross-platform parity', () => {
  it('same HudState produces non-empty output on both panels', async () => {
    const state = {
      ...initialHudState({
        sessionShortId: 'abc', workspaceName: 'w', provider: 'claude',
        model: 'opus-4-6', modelMaxContext: 200_000, turnNumber: 1,
        startedAtMs: 0, costSession: 0,
      }),
      currentActivity: { kind: 'tool_running' as const, toolName: 'Read', toolArg: 'a.ts', elapsedMs: 100 },
      toolTally: new Map([['Bash', 2]]),
      subagents: [{ agentId: 'a', name: 'gen', status: 'done_ok' as const }],
      todoList: [{ text: 'do x', status: 'in_progress' as const }],
      quotaBars: [{ label: 'Usage', pct: 67 }],
    };

    const tgAdapter = new FakeAdapter('telegram');
    const fsAdapter = new FakeAdapter('feishu');

    const tg = new TelegramHudPanel(tgAdapter, { channelType: 'telegram', chatId: 'c', role: 'primary' });
    const fs = new FeishuHudPanel(fsAdapter, { channelType: 'feishu', chatId: 'c', role: 'primary' });

    await tg.send(state);
    await fs.send(state);

    expect((tgAdapter.calls[0]!.args.text as string)).toContain('Read');
    expect((tgAdapter.calls[0]!.args.text as string)).toContain('Bash ×2');

    const card: unknown = fsAdapter.calls[0]!.args.card;
    const flat = JSON.stringify(card);
    expect(flat).toContain('Read');
    expect(flat).toContain('Bash ×2');
  });
});
