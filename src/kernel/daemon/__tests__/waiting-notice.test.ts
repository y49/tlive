import { describe, it, expect } from 'vitest';
import { renderWaiting, DETAIL_BUDGET, type WaitingEvent } from '../waiting-notice.js';

const notice = (over: Partial<WaitingEvent> = {}): WaitingEvent => ({
  key: 's1', label: 'drama-admin', kind: 'held', detail: 'Bash · pnpm build', ...over,
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

  // The fifth kind, and the only one that is not a question waiting for an
  // answer: the turn died on an error nothing retries its way out of (a bad
  // key, an exhausted balance), so nothing further will happen until you deal
  // with it. Transient kinds never get here — see the normalizer.
  it('a turn that died says so, and the body names the kind', () => {
    expect(renderWaiting(notice({ kind: 'sessionError', detail: 'billing_error — Credit balance too low' }), 'zh')).toEqual({
      title: 'drama-admin · 这轮失败了',
      body: 'billing_error — Credit balance too low',
    });
    expect(renderWaiting(notice({ kind: 'sessionError' }), 'en').title).toBe('drama-admin · turn failed');
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

  // Real-machine finding: an idle body carried `cache-control: no-store` with
  // its backticks intact, because the last assistant message is markdown and
  // nothing on this path stripped it. The body is one plain line on a lock
  // screen — markers are noise that eats a 90-character budget.
  it('strips markdown markers — a body is plain text, not markdown', () => {
    expect(renderWaiting(notice({ detail: 'set `cache-control: no-store` and **retry**' }), 'en').body)
      .toBe('set cache-control: no-store and retry');
    expect(renderWaiting(notice({ detail: '## Done\n\n- fixed *the* thing' }), 'en').body)
      .toBe('Done - fixed the thing');
    expect(renderWaiting(notice({ detail: '> quoted line' }), 'en').body).toBe('quoted line');
  });

  // Caught on a real screen an hour after the strip shipped: a body read
  // "三条事实: | | 状态 | 依据 | |---|---|---|" because the assistant's last
  // message contained a markdown table and the strip only knew about fences,
  // headings, quotes and emphasis.
  it('flattens markdown tables — pipes and separator rows are not text', () => {
    const md = 'Three facts:\n\n| | state | evidence |\n|---|---|---|\n| approval | works | companion.ts |';
    expect(renderWaiting(notice({ detail: md }), 'en').body)
      .toBe('Three facts: state · evidence approval · works · companion.ts');
  });

  it('an empty detail renders a title-only notification rather than repeating the title', () => {
    expect(renderWaiting(notice({ detail: '' }), 'zh')).toEqual({
      title: 'drama-admin · 等你批准',
      body: '',
    });
  });
});
