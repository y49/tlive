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

  it('keeps code content verbatim — live evidence: 2.0 code is inert (entities rendered literally ⟹ tags not parsed either)', () => {
    const els = mdToFeishuElements('```\na <at id=all></at> b\n```') as Md[];
    expect(els[0].content).toContain('<at id=all></at>'); // verbatim, not entity soup
    const inlineEls = mdToFeishuElements('run `a <at></at> b` now') as Md[];
    expect(inlineEls[0].content).toContain('`a <at></at> b`');
  });

  it('wraps an expandable excerpt (>! ) in a collapsible_panel (JSON 2.0), full text inside, first line as preview', () => {
    const md = '>! **Done.** All tests pass.\n>! Next: run `build`.\n\n*Reply to this message to continue.*';
    const els = mdToFeishuElements(md) as Array<Record<string, unknown>>;
    const panel = els.find((e) => e.tag === 'collapsible_panel') as { expanded: boolean; header: { title: { content: string } }; elements: Md[] };
    expect(panel).toBeTruthy();
    expect(panel.expanded).toBe(true); // read the last message without a tap
    expect(panel.header.title.content).toContain('**Done.** All tests pass.'); // preview = first line
    // the REST lives inside as flat markdown (first line is the header, not repeated in the body)
    const inner = panel.elements.map((e) => e.content).join('\n');
    expect(inner).toContain('Next: run `build`.');
    expect(inner).not.toContain('All tests pass'); // no duplication of the header line
    expect(inner).not.toContain('> ');
    // the reply hint is a SEPARATE element OUTSIDE the panel
    expect(els.some((e) => e.tag === 'markdown' && String(e.content).includes('*Reply to this message to continue.*'))).toBe(true);
  });

  it('splits paragraphs into separate elements (blank line = element boundary = visual gap)', () => {
    const els = mdToFeishuElements('para one\nstill one\n\npara two\n\npara three') as Md[];
    expect(els.map((e) => e.content)).toEqual(['para one\nstill one', 'para two', 'para three']);
  });

  it('does not clip a long excerpt — collapse handles length (full text inside the panel)', () => {
    const md = Array.from({ length: 20 }, (_, i) => `>! line ${i + 1}`).join('\n');
    const els = mdToFeishuElements(md) as Array<Record<string, unknown>>;
    const panel = els.find((e) => e.tag === 'collapsible_panel') as { elements: Md[] };
    expect(panel).toBeTruthy();
    const inner = panel.elements.map((e) => e.content).join('\n');
    expect(inner).toContain('line 20'); // nothing dropped
    expect(inner).not.toContain('more lines'); // no clip note
  });

  it('clips a real "> " blockquote at 8 lines — quotes stay quotes', () => {
    const md = Array.from({ length: 12 }, (_, i) => `> q ${i + 1}`).join('\n');
    const els = mdToFeishuElements(md) as Md[];
    const lines = els[0].content.split('\n');
    expect(lines).toHaveLength(9); // 8 kept + clip notice
    expect(lines[0]).toBe('> q 1');
    expect(lines[8]).toContain('+4 more lines');
  });

  it('emits no empty element for the real continue-card shape (leading \\n before the excerpt)', () => {
    const md = '\n>! All done.\n>! Tests pass.\n\n*Reply to this message to continue.*';
    const els = mdToFeishuElements(md) as Array<Record<string, unknown>>;
    for (const e of els) {
      if (e.tag === 'markdown') expect(String(e.content).trim()).not.toBe('');
      if (e.tag === 'collapsible_panel') {
        const inner = e.elements as Md[];
        expect(inner.length).toBeGreaterThan(0);
        for (const c of inner) expect(c.content.trim()).not.toBe('');
      }
    }
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

  it('omits buttons/form when the card has neither, and uses the plain white default header (settled card)', () => {
    const card = buildCard({ kind: 'card', title: 'Allowed · tlive · Bash', body: 'ls' }) as Card2;
    expect(card.body.elements.some((e) => e.tag === 'column_set' || e.tag === 'form')).toBe(false);
    expect(card.header!.template).toBe('default'); // non-actionable → plain white (blue is reserved for "needs you")
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
