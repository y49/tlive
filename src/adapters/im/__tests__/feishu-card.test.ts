import { describe, it, expect } from 'vitest';
import { buildCard } from '../feishu.js';
import { mdToFeishuElements } from '../feishu-card.js';

type Md = { tag: 'markdown'; content: string };
type Panel = { tag: 'collapsible_panel'; expanded: boolean; header: { title: { tag: 'plain_text'; content: string } }; elements: Md[] };

describe('mdToFeishuElements', () => {
  it('keeps a fenced code block verbatim in its own markdown element', () => {
    const els = mdToFeishuElements('\n\n```bash\nrm -rf /tmp/x\n```') as Md[];
    const fence = els.find((e) => e.content.startsWith('```bash'));
    expect(fence).toBeTruthy();
    expect(fence!.content).toBe('```bash\nrm -rf /tmp/x\n```');
  });

  it('degrades inline code to bold (card 1.0 renders backticks literally)', () => {
    const els = mdToFeishuElements('Write to `/etc/hosts`') as Md[];
    expect(els[0].content).toContain('**/etc/hosts**');
    expect(els[0].content).not.toContain('`');
  });

  it('does not let code-span content toggle bold/italic after degradation', () => {
    const els = mdToFeishuElements('run `a*b*c`') as Md[];
    // the * inside the span must be entity-escaped, not become italic
    expect(els[0].content).toContain('**a&#42;b&#42;c**');
  });

  it('escapes tag-like agent content in prose (no <at>/<text_tag> injection)', () => {
    const els = mdToFeishuElements('hi <at id=all></at> & <text_tag>x</text_tag>') as Md[];
    expect(els[0].content).not.toContain('<at');
    expect(els[0].content).not.toContain('<text_tag');
    expect(els[0].content).toContain('&#60;at id=all&#62;');
  });

  it('does not escape inside fences (code shown verbatim)', () => {
    const els = mdToFeishuElements('```\na < b && c > d\n```') as Md[];
    expect(els[0].content).toBe('```\na < b && c > d\n```');
  });

  it('turns an expandable quote block into a collapsible panel with a first-line preview header', () => {
    const md = '>! **Done.** All tests pass.\n>! Next: run `build`.\n\n*Reply to continue*';
    const els = mdToFeishuElements(md) as Array<Md | Panel>;
    const panel = els.find((e) => e.tag === 'collapsible_panel') as Panel;
    expect(panel).toBeTruthy();
    expect(panel.expanded).toBe(false);
    // header preview is plain text: markers stripped
    expect(panel.header.title.content).toBe('Done. All tests pass.');
    expect(panel.header.title.tag).toBe('plain_text');
    // full content inside, markers converted not leaked
    expect(panel.elements[0].content).toContain('**Done.**');
    expect(panel.elements[0].content).toContain('**build**');
    // trailing prose still renders after the panel
    const tail = els[els.length - 1] as Md;
    expect(tail.content).toContain('*Reply to continue*');
  });

  it('strips plain quote markers (1.0 would render "> " literally)', () => {
    const els = mdToFeishuElements('> quoted line\n> second') as Md[];
    expect(els[0].content).toBe('quoted line\nsecond');
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

describe('feishu buildCard', () => {
  it('renders approval buttons as callback behaviors carrying the button id', () => {
    const card = buildCard({
      kind: 'card',
      title: '权限请求: Edit',
      body: 'tool input: {...}',
      buttons: [
        { id: 'approve:abc', label: '✅ 允许' },
        { id: 'deny:abc', label: '❌ 拒绝' },
      ],
    }) as { header?: unknown; elements: Array<Record<string, unknown>> };

    expect(card.header).toBeTruthy();
    const action = card.elements.find((e) => e.tag === 'action') as
      | { actions: Array<{ tag: string; type: string; behaviors: Array<{ type: string; value: { tlive: string } }> }> }
      | undefined;
    expect(action).toBeTruthy();
    expect(action!.actions).toHaveLength(2);
    expect(action!.actions[0]).toMatchObject({
      tag: 'button',
      type: 'primary',
      behaviors: [{ type: 'callback', value: { tlive: 'approve:abc' } }],
    });
    expect(action!.actions[1].type).toBe('danger');
    expect(action!.actions[1].behaviors[0].value.tlive).toBe('deny:abc');
  });

  it('omits the action element when there are no buttons', () => {
    const card = buildCard({ kind: 'card', body: 'hi' }) as { elements: Array<Record<string, unknown>> };
    expect(card.elements.some((e) => e.tag === 'action')).toBe(false);
    expect(card.elements[0]).toMatchObject({ tag: 'markdown', content: 'hi' });
  });

  it('renders the body through the markdown converter (fence survives, inline code degrades)', () => {
    const card = buildCard({
      kind: 'card',
      title: 'tlive · Bash',
      body: '\n*list files*\n\n```bash\nls -la\n```',
      buttons: [{ id: 'approve:r1', label: 'Allow' }],
    }) as { elements: Array<{ tag: string; content?: string }> };
    const md = card.elements.filter((e) => e.tag === 'markdown');
    expect(md.some((e) => e.content === '```bash\nls -la\n```')).toBe(true);
    expect(md.some((e) => e.content?.includes('*list files*'))).toBe(true);
  });

  it('colors the header only when the card is actionable (has buttons)', () => {
    const actionable = buildCard({ kind: 'card', title: 't', body: 'b', buttons: [{ id: 'approve:x', label: 'Allow' }] }) as { header?: { template?: string } };
    const settled = buildCard({ kind: 'card', title: 't', body: 'b' }) as { header?: { template?: string } };
    expect(actionable.header?.template).toBe('blue');
    expect(settled.header?.template).toBeUndefined();
  });

  it('maps button style by intent: approve primary, deny danger, everything else default', () => {
    const card = buildCard({
      kind: 'card',
      body: 'b',
      buttons: [
        { id: 'approve:r', label: 'Allow' },
        { id: 'deny:r', label: 'Deny' },
        { id: 'allowtool:r:Bash', label: 'Always allow Bash' },
        { id: 'pause:r', label: 'Pause approvals' },
      ],
    }) as { elements: Array<{ tag: string; actions?: Array<{ type: string }> }> };
    const action = card.elements.find((e) => e.tag === 'action')!;
    expect(action.actions!.map((a) => a.type)).toEqual(['primary', 'danger', 'default', 'default']);
  });
});
