import { describe, it, expect, vi } from 'vitest';
import { AskCardController } from '../../../src/im/ask/ask-card-controller.js';
import type { AskUserQuestionRequest } from '../../../src/runtime/types.js';
import { FakeAdapter } from '../fake-adapter.js';

function tgt() {
  return { channelType: 'telegram' as const, chatId: 'c1', role: 'primary' as const };
}

describe('AskCardController', () => {
  it('open 创建 PermissionCard,markResolved 切 resolved 视觉 + 从 store 移除', async () => {
    const adapter = new FakeAdapter('telegram');
    const ctrl = new AskCardController(adapter, tgt());
    const onResolve = vi.fn();
    const req: AskUserQuestionRequest = {
      id: 'r1', prompt: 'q', options: [{ label: 'a' }, { label: 'b' }],
      multiSelect: true, allowCustom: false,
      resolve: onResolve,
    };
    await ctrl.open(req);
    expect(ctrl.has('r1')).toBe(true);
    // open issued one send.
    expect(adapter.calls.filter(c => c.kind === 'send').length).toBe(1);

    await ctrl.markResolved('r1', ['a']);
    // resolved visual = exactly one edit on the underlying message.
    const lastEdit = adapter.calls.filter(c => c.kind === 'edit').at(-1)!;
    expect(lastEdit).toBeTruthy();
    expect(lastEdit.args.text as string).toContain('已选');
    expect(lastEdit.args.text as string).toContain('a');
    expect(ctrl.has('r1')).toBe(false);
    // markResolved doesn't itself fire onResolve — that's wired via callback / IM flow.
  });

  it('cancelPending 清空 active cards', async () => {
    const adapter = new FakeAdapter('telegram');
    const ctrl = new AskCardController(adapter, tgt());
    const req: AskUserQuestionRequest = {
      id: 'r1', prompt: 'q', options: [{ label: 'a' }, { label: 'b' }],
      multiSelect: false, allowCustom: false, resolve: () => {},
    };
    await ctrl.open(req);
    expect(ctrl.has('r1')).toBe(true);
    ctrl.cancelPending();
    expect(ctrl.has('r1')).toBe(false);
  });

  it('markResolved on unknown reqId is a no-op', async () => {
    const adapter = new FakeAdapter('telegram');
    const ctrl = new AskCardController(adapter, tgt());
    const editsBefore = adapter.calls.filter(c => c.kind === 'edit').length;
    await ctrl.markResolved('nonexistent', ['x']);
    const editsAfter = adapter.calls.filter(c => c.kind === 'edit').length;
    expect(editsAfter).toBe(editsBefore);
  });

  it('open uses decideAskMode (multi when multiSelect=true)', async () => {
    const adapter = new FakeAdapter('telegram');
    const ctrl = new AskCardController(adapter, tgt());
    const req: AskUserQuestionRequest = {
      id: 'r-multi', prompt: 'q', options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: true, allowCustom: false, resolve: () => {},
    };
    await ctrl.open(req);
    const send = adapter.calls.find(c => c.kind === 'send')!;
    // v3.2.4: multi mode renders submit + skip row ("✓ 提交 (N)" + "❌ 跳过")
    const buttonsText = ((send.args.replyMarkup as any).buttons as Array<Array<{ text: string }>>)
      .flat().map(b => b.text).join('|');
    expect(buttonsText).toMatch(/提交/);
    expect(buttonsText).toMatch(/跳过/);
  });
});
