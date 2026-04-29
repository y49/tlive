import { describe, it, expect, vi } from 'vitest';
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
      kind: 'ask', requestId: 'a1', mode: 'single', question: 'pick one',
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
      kind: 'ask', requestId: 'a1', mode: 'single', question: 'q',
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
      kind: 'ask', requestId: 'a2', mode: 'multi', question: 'pick many',
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
      kind: 'ask', requestId: 'a2', mode: 'multi', question: 'q',
      options: [{ label: 'A' }], onResolve,
    });
    await card.send();
    await card.handleCallback('ask:a2:confirm');
    expect(onResolve).toHaveBeenCalledWith([]);
  });
});

describe('PermissionCard — ask custom-input', () => {
  it('switches to pending state on custom button click', async () => {
    const adapter = new FakeAdapter('telegram');
    const card = new PermissionCard(adapter, tgt(), {
      kind: 'ask', requestId: 'a3', mode: 'custom-input', question: 'q',
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
      kind: 'ask', requestId: 'a3', mode: 'custom-input', question: 'q',
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
      kind: 'ask', requestId: 'as', mode: 'single', question: 'q',
      options: [{ label: '茶' }, { label: '咖啡' }], onResolve,
    });
    await card.send();
    await card.resolveWithPlaintext('2');
    expect(onResolve).toHaveBeenCalledWith(['咖啡']);
  });

  it('resolveWithPlaintext on multi mode parses comma-separated', async () => {
    const onResolve = vi.fn();
    const card = new PermissionCard(new FakeAdapter('telegram'), tgt(), {
      kind: 'ask', requestId: 'am', mode: 'multi', question: 'q',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], onResolve,
    });
    await card.send();
    await card.resolveWithPlaintext('1,3');
    expect(onResolve).toHaveBeenCalledWith(['A', 'C']);
  });
});
