import { describe, it, expect } from 'vitest';
import { buildCard } from '../feishu.js';
import { mdToFeishuElements } from '../feishu-card.js';

type Md = { tag: 'markdown'; content: string };
type Card2 = {
  schema: string;
  config: { update_multi: boolean };
  header?: { title: { tag: string; content: string }; template?: string };
  body: { elements: Array<Record<string, unknown>> };
};

describe('mdToFeishuElements (card JSON 2.0 — markdown is near-passthrough)', () => {
  it('keeps a fenced code block verbatim in its own markdown element', () => {
    const els = mdToFeishuElements('\n\n```bash\nrm -rf /tmp/x\n```') as Md[];
    const fence = els.find((e) => e.content.startsWith('```bash'));
    expect(fence).toBeTruthy();
    expect(fence!.content).toBe('```bash\nrm -rf /tmp/x\n```');
  });

  it('keeps inline code as-is (2.0 markdown renders backticks natively)', () => {
    const els = mdToFeishuElements('Write to `/etc/hosts`') as Md[];
    expect(els[0].content).toContain('`/etc/hosts`');
  });

  it('escapes tag-like agent content in prose (no <at>/<text_tag> injection)', () => {
    const els = mdToFeishuElements('hi <at id=all></at> & <text_tag>x</text_tag>') as Md[];
    expect(els[0].content).not.toContain('<at');
    expect(els[0].content).not.toContain('<text_tag');
    expect(els[0].content).toContain('&#60;at id=all&#62;');
  });

  it('escapes tag-like content inside fences too (tag-inside-code parsing is unverified — never gamble on injection)', () => {
    const els = mdToFeishuElements('```\na <at id=all></at> b\n```') as Md[];
    expect(els[0].content).not.toContain('<at');
    expect(els[0].content).toContain('&#60;at id=all&#62;');
  });

  it('renders an expandable quote block as a native 2.0 quote (collapsible_panel retired — it never rendered on real clients)', () => {
    const md = '>! **Done.** All tests pass.\n>! Next: run `build`.\n\n*Reply to continue*';
    const els = mdToFeishuElements(md) as Md[];
    expect(els.some((e) => e.tag === 'collapsible_panel')).toBe(false);
    expect(els[0].content).toContain('> **Done.** All tests pass.');
    expect(els[0].content).toContain('> Next: run `build`.');
    expect(els[0].content).toContain('*Reply to continue*');
  });

  it('emits no empty element for the real continue-card shape (leading \\n before the quote)', () => {
    const md = '\n>! All done.\n>! Tests pass.\n\n*Reply to continue*';
    const els = mdToFeishuElements(md) as Md[];
    for (const e of els) expect(e.content.trim()).not.toBe('');
  });

  it('keeps plain quote markers (2.0 renders "> " as a real blockquote)', () => {
    const els = mdToFeishuElements('> quoted line\n> second') as Md[];
    expect(els[0].content).toBe('> quoted line\n> second');
  });

  it('strips spoiler markers', () => {
    const els = mdToFeishuElements('a ||hidden|| b') as Md[];
    expect(els[0].content).toBe('a hidden b');
  });

  it('emits a placeholder element for an empty body (a card must not have zero elements)', () => {
    const els = mdToFeishuElements('') as Md[];
    expect(els.length).toBeGreaterThan(0);
  });
});

describe('feishu buildCard (schema 2.0)', () => {
  it('declares schema 2.0 with update_multi and puts elements under body', () => {
    const card = buildCard({ kind: 'card', body: 'hi' }) as Card2;
    expect(card.schema).toBe('2.0');
    expect(card.config.update_multi).toBe(true);
    expect(card.body.elements[0]).toMatchObject({ tag: 'markdown', content: 'hi' });
  });

  it('renders buttons two per column_set row, as callback behaviors carrying the button id', () => {
    const card = buildCard({
      kind: 'card',
      title: 'tlive · Edit',
      body: 'tool input: {...}',
      buttons: [
        { id: 'approve:abc', label: 'Allow' },
        { id: 'deny:abc', label: 'Deny' },
        { id: 'pause:abc', label: 'Pause approvals' },
      ],
    }) as Card2;
    expect(card.header).toBeTruthy();
    expect(card.header!.template).toBe('blue');
    const rows = card.body.elements.filter((e) => e.tag === 'column_set') as Array<{ columns: Array<{ elements: Array<Record<string, unknown>> }> }>;
    expect(rows).toHaveLength(2); // 3 buttons → row of 2 + row of 1
    const first = rows[0].columns.map((c) => c.elements[0]);
    expect(first[0]).toMatchObject({ tag: 'button', type: 'primary', behaviors: [{ type: 'callback', value: { tlive: 'approve:abc' } }] });
    expect(first[1]).toMatchObject({ type: 'danger', behaviors: [{ type: 'callback', value: { tlive: 'deny:abc' } }] });
    expect(rows[1].columns).toHaveLength(1);
  });

  it('renders a form with a multiline input + submit when inputAction is set (the native reply box)', () => {
    const card = buildCard({
      kind: 'card',
      title: 'y · Question',
      body: 'Pick one',
      buttons: [{ id: 'ask:r1:0', label: '1. Red' }],
      inputAction: { id: 'askinput:r1', placeholder: 'Answer in your own words', submitLabel: 'Send' },
    }) as Card2;
    const form = card.body.elements.find((e) => e.tag === 'form') as { name: string; elements: Array<Record<string, unknown>> };
    expect(form).toBeTruthy();
    expect(form.elements[0]).toMatchObject({ tag: 'input', name: 'reply', input_type: 'multiline_text' });
    expect(form.elements[1]).toMatchObject({
      tag: 'button',
      form_action_type: 'submit', // probed live: 2.0 rejects 1.0's action_type:'form_submit'
      behaviors: [{ type: 'callback', value: { tlive: 'askinput:r1' } }],
    });
  });

  it('omits buttons/form when the card has neither (settled card)', () => {
    const card = buildCard({ kind: 'card', title: 'Allowed · tlive · Bash', body: 'ls' }) as Card2;
    expect(card.body.elements.some((e) => e.tag === 'column_set' || e.tag === 'form')).toBe(false);
    expect(card.header!.template).toBeUndefined(); // settled card steps back visually
  });

  it('maps button style by intent: approve primary, deny danger, everything else default', () => {
    const card = buildCard({
      kind: 'card',
      body: 'x',
      buttons: [
        { id: 'approve:1', label: 'a' },
        { id: 'deny:1', label: 'd' },
        { id: 'allowtool:1:Bash', label: 't' },
        { id: 'pause:1', label: 'p' },
      ],
    }) as Card2;
    const btns = (card.body.elements.filter((e) => e.tag === 'column_set') as Array<{ columns: Array<{ elements: Array<{ type?: string }> }> }>)
      .flatMap((r) => r.columns.map((c) => c.elements[0]));
    expect(btns.map((b) => b.type)).toEqual(['primary', 'danger', 'default', 'default']);
  });
});
