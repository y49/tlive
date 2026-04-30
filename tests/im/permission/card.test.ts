import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionCard } from '../../../src/im/permission/card.js';
import { FakeAdapter } from '../fake-adapter.js';

function tgt() { return { channelType: 'telegram' as const, chatId: 'c', role: 'primary' as const }; }

describe('PermissionCard — generic permission', () => {
  it('send emits 4-button keyboard with all 4 verbs', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic',
      requestId: 'p1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      onResolve: vi.fn(),
    });
    await card.send();
    const send = adapter.calls[0];
    expect(send.kind).toBe('send');
    const buttons = (send.args.replyMarkup as any).buttons.flat();
    const labels = buttons.map((b: any) => b.text);
    expect(labels).toEqual(expect.arrayContaining(['✅ Allow', '❌ Deny', '🔄 Always', '💡 Learn']));
  });

  it('handleCallback "allow" calls onResolve("allow") and edits card to resolved state', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'p1', toolName: 'Bash', toolInput: {}, onResolve,
    });
    await card.send();
    await card.handleCallback('perm:p1:allow');
    expect(onResolve).toHaveBeenCalledWith('allow');
    // Card should have been edited to show resolved state.
    const lastEdit = adapter.calls.filter(c => c.kind === 'edit').at(-1);
    expect(lastEdit).toBeTruthy();
    expect((lastEdit!.args.text as string)).toMatch(/allow/i);
  });

  it('handleCallback "deny" and "always" each call onResolve with the right verb', async () => {
    const adapter = new FakeAdapter('telegram');
    const onDeny = vi.fn();
    const cardDeny = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'p2', toolName: 'X', toolInput: {}, onResolve: onDeny,
    });
    await cardDeny.send();
    await cardDeny.handleCallback('perm:p2:deny');
    expect(onDeny).toHaveBeenCalledWith('deny');

    const onAlways = vi.fn();
    const cardAlways = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'generic', requestId: 'p3', toolName: 'X', toolInput: {}, onResolve: onAlways,
    });
    await cardAlways.send();
    await cardAlways.handleCallback('perm:p3:always');
    expect(onAlways).toHaveBeenCalledWith('always');
  });

  it('handleCallback "learn" does NOT resolve (it\'s a side path)', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'p4', toolName: 'X', toolInput: {}, onResolve,
    });
    await card.send();
    await card.handleCallback('perm:p4:learn');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('mismatched requestId is ignored', async () => {
    const onResolve = vi.fn();
    const card = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'generic', requestId: 'p5', toolName: 'X', toolInput: {}, onResolve,
    });
    await card.send();
    await card.handleCallback('perm:differentReqId:allow');
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe('PermissionCard — ask single', () => {
  it('one button per option', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'a1', multi: false, allowCustom: false, question: 'pick one',
      options: [{ label: '茶' }, { label: '咖啡' }, { label: '水' }],
      onResolve: vi.fn(),
    });
    await card.send();
    const buttons = (adapter.calls[0].args.replyMarkup as any).buttons.flat();
    expect(buttons.map((b: any) => b.text)).toEqual(expect.arrayContaining(['茶', '咖啡', '水']));
  });

  it('button click resolves with chosen label and edits card', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'a1', multi: false, allowCustom: false, question: 'q',
      options: [{ label: '茶' }, { label: '水' }], onResolve,
    });
    await card.send();
    await card.handleCallback('ask:a1:opt:1');
    expect(onResolve).toHaveBeenCalledWith(['水']);
  });
});

describe('PermissionCard — ask multi', () => {
  it('toggles buttons via ⬜/✅ and submits selected labels on confirm', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'a2', multi: true, allowCustom: false, question: 'pick many',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], onResolve,
    });
    await card.send();
    await card.handleCallback('ask:a2:opt:0');
    await card.handleCallback('ask:a2:opt:2');

    const lastEdit = adapter.calls.filter(c => c.kind === 'edit').at(-1)!;
    const buttons = (lastEdit.args.markup as any).buttons.flat();
    expect(buttons.find((b: any) => /A/.test(b.text)).text).toMatch(/✅/);
    expect(buttons.find((b: any) => /B/.test(b.text)).text).toMatch(/⬜/);
    expect(buttons.find((b: any) => /C/.test(b.text)).text).toMatch(/✅/);

    await card.handleCallback('ask:a2:confirm');
    expect(onResolve).toHaveBeenCalledWith(['A', 'C']);
  });

  it('confirm with no selection still resolves (with empty array)', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'a2', multi: true, allowCustom: false, question: 'q',
      options: [{ label: 'A' }], onResolve,
    });
    await card.send();
    await card.handleCallback('ask:a2:confirm');
    expect(onResolve).toHaveBeenCalledWith([]);
  });
});

describe('PermissionCard — race guard', () => {
  it('handleCallback double-click fires onResolve only once', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'pr', toolName: 'Bash', toolInput: {}, onResolve,
    });
    await card.send();
    await Promise.all([
      card.handleCallback('perm:pr:allow'),
      card.handleCallback('perm:pr:allow'),
    ]);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('resolveWithPlaintext after click is a no-op', async () => {
    const onResolve = vi.fn();
    const card = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'ask', requestId: 'ar', multi: false, allowCustom: false, question: 'q',
      options: [{ label: 'A' }], onResolve,
    });
    await card.send();
    await card.handleCallback('ask:ar:opt:0');
    await card.resolveWithPlaintext('A');
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('multi-mode toggle clicks do NOT trigger the race guard', async () => {
    const onResolve = vi.fn();
    const card = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'ask', requestId: 'am', multi: true, allowCustom: false, question: 'q',
      options: [{ label: 'A' }, { label: 'B' }], onResolve,
    });
    await card.send();
    // Toggle on, off, on — none of these resolve.
    await card.handleCallback('ask:am:opt:0');
    await card.handleCallback('ask:am:opt:0');
    await card.handleCallback('ask:am:opt:1');
    expect(onResolve).not.toHaveBeenCalled();
    // Confirm fires onResolve once.
    await card.handleCallback('ask:am:confirm');
    expect(onResolve).toHaveBeenCalledTimes(1);
    // A second confirm is a no-op.
    await card.handleCallback('ask:am:confirm');
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});

describe('PermissionCard — §7.5 retry + fallback (generic)', () => {
  function makeFlakyAdapter(failTimes: number) {
    const adapter = new FakeAdapter('telegram');
    let calls = 0;
    const realSend = adapter.send.bind(adapter);
    adapter.send = async (msg: any) => {
      calls++;
      if (calls <= failTimes) throw new Error(`flake ${calls}`);
      return await realSend(msg);
    };
    return { adapter, getCalls: () => calls };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('retries once after 1s on first send failure', async () => {
    const { adapter, getCalls } = makeFlakyAdapter(1);
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'pr', toolName: 'Bash', toolInput: {}, onResolve: vi.fn(),
    });
    const sendPromise = card.send();
    await vi.advanceTimersByTimeAsync(1100);
    await sendPromise;
    expect(getCalls()).toBe(2); // 1 fail + 1 success
    expect(card.isPermFallbackPending()).toBe(false);
  });

  it('sends plaintext fallback after two send failures', async () => {
    const { adapter, getCalls } = makeFlakyAdapter(2);
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'pr', toolName: 'Bash', toolInput: {}, onResolve: vi.fn(),
    });
    const sendPromise = card.send();
    await vi.advanceTimersByTimeAsync(1100);
    await sendPromise;
    expect(getCalls()).toBe(3); // 1st card try + 2nd card try + plaintext fallback
    expect(card.isPermFallbackPending()).toBe(true);
    const lastSend = adapter.calls[adapter.calls.length - 1];
    expect((lastSend.args.text as string)).toContain('Permission needed for Bash');
    expect((lastSend.args.text as string)).toContain("'allow' or 'deny'");
  });

  it('resolveFromKeyword resolves a fallback-pending card and is idempotent', async () => {
    const { adapter } = makeFlakyAdapter(2);
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'pr', toolName: 'Bash', toolInput: {}, onResolve,
    });
    const sendPromise = card.send();
    await vi.advanceTimersByTimeAsync(1100);
    await sendPromise;
    await card.resolveFromKeyword('allow');
    expect(onResolve).toHaveBeenCalledWith('allow');
    // Second call is no-op.
    await card.resolveFromKeyword('deny');
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('resolveFromKeyword on non-fallback card resolves normally (guard is resolved flag, not fallbackPending)', async () => {
    vi.useRealTimers();
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'pr', toolName: 'Bash', toolInput: {}, onResolve,
    });
    await card.send();
    expect(card.isPermFallbackPending()).toBe(false);
    await card.resolveFromKeyword('allow');
    // resolveFromKeyword still resolves even when not in fallback state — race guard is `resolved`.
    expect(onResolve).toHaveBeenCalledWith('allow');
    vi.useFakeTimers();
  });

  it('resolveFromKeyword on ask-mode card is rejected', async () => {
    vi.useRealTimers();
    const onResolve = vi.fn();
    const card = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'ask', requestId: 'a', multi: false, allowCustom: false, question: 'q',
      options: [{ label: 'A' }], onResolve,
    });
    await card.send();
    await card.resolveFromKeyword('allow');
    expect(onResolve).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });
});

describe('PermissionCard — ask custom-input', () => {
  it('switches to pending state on custom button click', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'a3', multi: false, allowCustom: true, question: 'q',
      options: [{ label: 'A' }], onResolve: vi.fn(),
    });
    await card.send();
    expect(card.expectsPlaintextRelay()).toBe(false);
    await card.handleCallback('ask:a3:custom');
    expect(card.expectsPlaintextRelay()).toBe(true);
    const lastEdit = adapter.calls.filter(c => c.kind === 'edit').at(-1)!;
    expect((lastEdit.args.text as string)).toMatch(/⌛/);
  });

  it('resolveWithPlaintext resolves verbatim when expecting relay', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'a3', multi: false, allowCustom: true, question: 'q',
      options: [{ label: 'A' }], onResolve,
    });
    await card.send();
    await card.handleCallback('ask:a3:custom');
    await card.resolveWithPlaintext('我自己写一个');
    expect(onResolve).toHaveBeenCalledWith(['我自己写一个']);
  });

  it('resolveWithPlaintext on single mode parses integer / label / substring', async () => {
    const onResolve = vi.fn();
    const card = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'ask', requestId: 'as', multi: false, allowCustom: false, question: 'q',
      options: [{ label: '茶' }, { label: '咖啡' }], onResolve,
    });
    await card.send();
    await card.resolveWithPlaintext('2');
    expect(onResolve).toHaveBeenCalledWith(['咖啡']);
  });

  it('resolveWithPlaintext on multi mode parses comma-separated', async () => {
    const onResolve = vi.fn();
    const card = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'ask', requestId: 'am', multi: true, allowCustom: false, question: 'q',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], onResolve,
    });
    await card.send();
    await card.resolveWithPlaintext('1,3');
    expect(onResolve).toHaveBeenCalledWith(['A', 'C']);
  });
});

describe('PermissionCard kind=ask — resolved 视觉', () => {
  it('multi 模式 resolve 后 edit 显示 ✅ 已选: ...', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'r1', multi: true, allowCustom: false,
      question: '选模块', options: [{ label: '认证' }, { label: '看板' }],
      onResolve: vi.fn(),
    });
    await card.send();
    await card.markResolvedAsk(['认证', '看板']);
    const lastEdit = adapter.calls.filter(c => c.kind === 'edit').at(-1)!;
    const text = lastEdit.args.text as string;
    expect(text).toContain('✅ 已选');
    expect(text).toContain('认证');
    expect(text).toContain('看板');
    expect(text).not.toContain('提交');  // confirm button residue cleared
  });

  it('空 chosen 显示 (已跳过)', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'r2', multi: true, allowCustom: false,
      question: 'q', options: [{ label: 'a' }, { label: 'b' }],
      onResolve: vi.fn(),
    });
    await card.send();
    await card.markResolvedAsk([]);
    const lastEdit = adapter.calls.filter(c => c.kind === 'edit').at(-1)!;
    expect(lastEdit.args.text as string).toContain('已跳过');
  });

  it('markResolvedAsk on generic card is a no-op', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'generic', requestId: 'p', toolName: 'Bash', toolInput: {}, onResolve: vi.fn(),
    });
    await card.send();
    const editsBefore = adapter.calls.filter(c => c.kind === 'edit').length;
    await card.markResolvedAsk(['x']);
    const editsAfter = adapter.calls.filter(c => c.kind === 'edit').length;
    expect(editsAfter).toBe(editsBefore);
  });

  it('markResolvedAsk is idempotent (second call is a no-op)', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'r3', multi: true, allowCustom: false, question: 'q',
      options: [{ label: 'a' }], onResolve: vi.fn(),
    });
    await card.send();
    await card.markResolvedAsk(['a']);
    const editsAfterFirst = adapter.calls.filter(c => c.kind === 'edit').length;
    await card.markResolvedAsk(['a']);
    const editsAfterSecond = adapter.calls.filter(c => c.kind === 'edit').length;
    expect(editsAfterSecond).toBe(editsAfterFirst);
  });
});

describe('PermissionCard — v3.2.4 multi + custom combinations', () => {
  function buildAsk(opts: { multi: boolean; allowCustom: boolean; onResolve?: any }) {
    return {
      kind: 'ask' as const, requestId: 'r1', question: 'pick',
      multi: opts.multi, allowCustom: opts.allowCustom,
      options: [{ label: 'A' }, { label: 'B' }],
      onResolve: opts.onResolve ?? vi.fn(),
    };
  }

  function btnLabels(adapter: FakeAdapter): string[] {
    const send = adapter.calls.find(c => c.kind === 'send')!;
    const buttons = ((send.args.replyMarkup as any).buttons as Array<Array<{ text: string }>>);
    return buttons.flat().map(b => b.text);
  }

  it('!multi !allowCustom → option buttons only, no custom, no submit/skip', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), buildAsk({ multi: false, allowCustom: false }));
    await card.send();
    const labels = btnLabels(adapter);
    expect(labels).toEqual(['A', 'B']);
    expect(labels.some(l => l.includes('自定义'))).toBe(false);
    expect(labels.some(l => l.includes('提交'))).toBe(false);
  });

  it('!multi allowCustom → option buttons + ✏️ custom (no submit row)', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), buildAsk({ multi: false, allowCustom: true }));
    await card.send();
    const labels = btnLabels(adapter);
    expect(labels).toContain('A');
    expect(labels).toContain('B');
    expect(labels.some(l => l.includes('自己输入'))).toBe(true);
    expect(labels.some(l => l.includes('提交'))).toBe(false);
  });

  it('multi !allowCustom → ☑/⬜ toggles + 提交/跳过 (no custom)', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), buildAsk({ multi: true, allowCustom: false }));
    await card.send();
    const labels = btnLabels(adapter);
    expect(labels.some(l => l.includes('⬜ A'))).toBe(true);
    expect(labels.some(l => l.includes('⬜ B'))).toBe(true);
    expect(labels.some(l => l.includes('提交'))).toBe(true);
    expect(labels.some(l => l.includes('跳过'))).toBe(true);
    expect(labels.some(l => l.includes('自定义'))).toBe(false);
  });

  it('multi allowCustom → ☑/⬜ + ✏️ 加自定义 + 提交/跳过 (full matrix)', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), buildAsk({ multi: true, allowCustom: true }));
    await card.send();
    const labels = btnLabels(adapter);
    expect(labels.some(l => l.includes('⬜ A'))).toBe(true);
    expect(labels.some(l => l.includes('加自定义'))).toBe(true);
    expect(labels.some(l => l.includes('提交'))).toBe(true);
    expect(labels.some(l => l.includes('跳过'))).toBe(true);
  });

  it('multi+custom: plaintext during customInputPending appends to customs[], confirm sends both', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), buildAsk({
      multi: true, allowCustom: true, onResolve,
    }));
    await card.send();
    // Toggle option A
    await card.handleCallback('ask:r1:opt:0');
    // Click custom — enters pending state
    await card.handleCallback('ask:r1:custom');
    // User sends plaintext
    await card.resolveWithPlaintext('our own answer');
    // Should NOT have resolved yet; expect custom appended + edit re-rendered
    expect(onResolve).not.toHaveBeenCalled();
    // Confirm
    await card.handleCallback('ask:r1:confirm');
    expect(onResolve).toHaveBeenCalledWith(['A', 'our own answer']);
  });

  it('multi+custom: skip resolves with empty array regardless of toggles', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), buildAsk({
      multi: true, allowCustom: true, onResolve,
    }));
    await card.send();
    await card.handleCallback('ask:r1:opt:0');
    await card.handleCallback('ask:r1:skip');
    expect(onResolve).toHaveBeenCalledWith([]);
  });

  it('single+custom: plaintext during customInputPending resolves immediately', async () => {
    const adapter = new FakeAdapter('telegram');
    const onResolve = vi.fn();
    const card = new PermissionCard(adapter, tgt(), buildAsk({
      multi: false, allowCustom: true, onResolve,
    }));
    await card.send();
    await card.handleCallback('ask:r1:custom');
    await card.resolveWithPlaintext('my answer');
    expect(onResolve).toHaveBeenCalledWith(['my answer']);
  });
});
