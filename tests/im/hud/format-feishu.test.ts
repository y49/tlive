import { describe, it, expect } from 'vitest';
import { buildFeishuHudCard } from '../../../src/im/hud/format-feishu.js';
import { initialHudState } from '../../../src/im/hud/state.js';

function s() {
  return initialHudState({
    sessionShortId: '8cdfcfb',
    workspaceName: 'tlive',
    provider: 'claude',
    model: 'opus-4-6',
    modelMaxContext: 200_000,
    turnNumber: 5,
    startedAtMs: 0,
    costSession: 0.32,
  });
}

describe('buildFeishuHudCard', () => {
  it('returns a card with schema 2.0 and header containing turn + sessionShortId', () => {
    const card = buildFeishuHudCard(s());
    expect(card.schema).toBe('2.0');
    const header: any = (card as any).header;
    expect(header.title.content).toContain('turn 5');
    expect(header.title.content).toContain('8cdfcfb');
  });

  it('uses blue header template when live, grey when frozen, red when errored', () => {
    expect((buildFeishuHudCard(s()) as any).header.template).toBe('blue');
    expect((buildFeishuHudCard({ ...s(), isFrozen: true }) as any).header.template).toBe('grey');
    expect((buildFeishuHudCard({ ...s(), isErrored: true }) as any).header.template).toBe('red');
  });

  it('body has at least the model+workspace markdown line', () => {
    const card: any = buildFeishuHudCard(s());
    const md = card.body.elements.find((e: any) => e.tag === 'markdown');
    expect(md).toBeTruthy();
    expect(md.content).toContain('opus-4-6');
    expect(md.content).toContain('tlive');
  });

  it('renders progress_bar for context + each quotaBar', () => {
    const state = {
      ...s(),
      contextUsedTok: 146_000,
      quotaBars: [{ label: 'Usage', pct: 67 }, { label: 'Weekly', pct: 44 }],
    };
    const card: any = buildFeishuHudCard(state);
    const bars = card.body.elements.filter((e: any) => e.tag === 'progress_bar');
    expect(bars).toHaveLength(3);
    expect(bars[0].label).toBe('Context');
    expect(bars[0].percent).toBe(73);
  });

  it('renders activity element only when currentActivity != null', () => {
    const noAct: any = buildFeishuHudCard(s());
    expect(noAct.body.elements.some((e: any) => e.tag === 'markdown' && /◐/.test(e.content))).toBe(false);

    const withAct: any = buildFeishuHudCard({
      ...s(),
      currentActivity: { kind: 'tool_running', toolName: 'Read', toolArg: 'a.ts', elapsedMs: 100 },
    });
    expect(withAct.body.elements.some((e: any) => e.tag === 'markdown' && /Read/.test(e.content))).toBe(true);
  });

  it('renders subagents and todoList when present', () => {
    const card: any = buildFeishuHudCard({
      ...s(),
      subagents: [{ agentId: 'a', name: 'gen', status: 'done_ok' }],
      todoList: [{ text: 'do x', status: 'in_progress' }],
    });
    const md = card.body.elements.filter((e: any) => e.tag === 'markdown');
    expect(md.some((e: any) => e.content.includes('gen'))).toBe(true);
    expect(md.some((e: any) => e.content.includes('do x'))).toBe(true);
  });

  it('always ends with a note element containing cost + duration', () => {
    const card: any = buildFeishuHudCard({ ...s(), costThisTurn: 0.04, durationMs: 4_200 });
    const last = card.body.elements[card.body.elements.length - 1];
    expect(last.tag).toBe('note');
    const text = last.elements?.[0]?.content ?? '';
    expect(text).toContain('$0.04');
    expect(text).toContain('4.2s');
  });
});
