import { describe, it, expect } from 'vitest';
import { renderWaiting, DETAIL_BUDGET, type WaitingNotice } from '../waiting-notice.js';

const notice = (over: Partial<WaitingNotice> = {}): WaitingNotice => ({
  label: 'drama-admin', kind: 'held', detail: 'Bash · pnpm build', ...over,
});

describe('renderWaiting', () => {
  it('en: title names the project and why it is calling you, body says what it is', () => {
    expect(renderWaiting(notice(), 'en')).toEqual({
      title: 'drama-admin · approval needed',
      body: 'Bash · pnpm build',
    });
  });

  it('zh: same shape, verb-phrase register', () => {
    expect(renderWaiting(notice(), 'zh')).toEqual({
      title: 'drama-admin · 等你批准',
      body: 'Bash · pnpm build',
    });
  });

  it('a sub-agent says so — it is the one reason the user cannot answer from the card', () => {
    expect(renderWaiting(notice({ kind: 'subagent' }), 'zh').title).toBe('drama-admin · 子代理等你批准');
    expect(renderWaiting(notice({ kind: 'subagent' }), 'en').title).toBe('drama-admin · sub-agent needs approval');
  });

  it('a CC-native dialog reads identically to a held one — to the person being called they ARE the same request', () => {
    expect(renderWaiting(notice({ kind: 'localPrompt' }), 'zh').title).toBe('drama-admin · 等你批准');
  });

  it('idle', () => {
    expect(renderWaiting(notice({ kind: 'idle', detail: '改完了,932 条测试全过' }), 'zh')).toEqual({
      title: 'drama-admin · 等你输入',
      body: '改完了,932 条测试全过',
    });
    expect(renderWaiting(notice({ kind: 'idle' }), 'en').title).toBe('drama-admin · waiting for your input');
  });

  it('an unlabelled session (registry miss) degrades to the bare reason, never a stray separator', () => {
    expect(renderWaiting(notice({ label: '' }), 'zh').title).toBe('等你批准');
  });

  it('masks secrets in the body — a notification is visible on a lock screen and in a screen share', () => {
    expect(renderWaiting(notice({ detail: 'Bash · deploy --token=hunter2' }), 'en').body)
      .toBe('Bash · deploy --token=***');
  });

  it('collapses whitespace and caps the body — the server clips it anyway, and a cap is what makes the cap testable', () => {
    const body = renderWaiting(notice({ detail: `Bash · ${'x'.repeat(200)}` }), 'en').body;
    expect(body).toHaveLength(DETAIL_BUDGET);
    expect(body.endsWith('…')).toBe(true);
    expect(renderWaiting(notice({ detail: 'a \n b' }), 'en').body).toBe('a b');
  });

  it('an empty detail renders a title-only notification rather than repeating the title', () => {
    expect(renderWaiting(notice({ detail: '' }), 'zh')).toEqual({
      title: 'drama-admin · 等你批准',
      body: '',
    });
  });
});
