import { describe, it, expect } from 'vitest';
import { FeishuRenderer } from '../renderers/feishu.js';
import type {
  NotificationEvent, ProgressSnapshot, CommandResponseData, TodoItem,
} from '../renderers/types.js';

/** Parse the card JSON and return the object for assertions. */
function parseCard(cardJson: string) {
  const card = JSON.parse(cardJson);
  return card as {
    schema: string;
    config: { wide_screen_mode: boolean };
    header: {
      template: string;
      title: { tag: string; content: string };
    };
    body: {
      elements: Array<{ tag: string; content?: string; [key: string]: unknown }>;
    };
  };
}

describe('FeishuRenderer', () => {
  const renderer = new FeishuRenderer();

  // ─── channelType ────────────────────────────────

  it('has channelType "feishu"', () => {
    expect(renderer.channelType).toBe('feishu');
  });

  // ─── renderNotification ─────────────────────────

  describe('renderNotification', () => {
    describe('permission_request', () => {
      it('renders orange card with permission header', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'npm test -- schema.test.ts',
          permissionId: 'perm-123',
          expiresInMinutes: 5,
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.schema).toBe('2.0');
        expect(card.config.wide_screen_mode).toBe(true);
        expect(card.header.template).toBe('orange');
        expect(card.header.title.tag).toBe('plain_text');
        expect(card.header.title.content).toContain('Permission Required');
      });

      it('includes tool name and input in code block', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'npm test',
          permissionId: 'perm-1',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdElements = card.body.elements.filter(e => e.tag === 'markdown');
        const toolElement = mdElements.find(e => e.content?.includes('**Tool:**'));
        expect(toolElement).toBeDefined();
        expect(toolElement!.content).toContain('Bash');

        const codeElement = mdElements.find(e => e.content?.includes('```'));
        expect(codeElement).toBeDefined();
        expect(codeElement!.content).toContain('npm test');
      });

      it('includes expiry information', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'test',
          permissionId: 'perm-1',
          expiresInMinutes: 10,
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdElements = card.body.elements.filter(e => e.tag === 'markdown');
        const expiryEl = mdElements.find(e => e.content?.includes('Expires'));
        expect(expiryEl).toBeDefined();
        expect(expiryEl!.content).toContain('10 minutes');
      });

      it('defaults expiresInMinutes to 5', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'test',
          permissionId: 'perm-1',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdElements = card.body.elements.filter(e => e.tag === 'markdown');
        const expiryEl = mdElements.find(e => e.content?.includes('Expires'));
        expect(expiryEl!.content).toContain('5 minutes');
      });

      it('includes allow/deny buttons with correct callbackData', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'rm -rf /',
          permissionId: 'perm-abc',
        };
        const result = renderer.renderNotification(event);
        expect(result.buttons).toHaveLength(2);
        expect(result.buttons![0].callbackData).toBe('perm:allow:perm-abc');
        expect(result.buttons![0].style).toBe('primary');
        expect(result.buttons![1].callbackData).toBe('perm:deny:perm-abc');
        expect(result.buttons![1].style).toBe('danger');
      });

      it('truncates toolInput to 300 chars', () => {
        const longInput = 'x'.repeat(400);
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: longInput,
          permissionId: 'perm-1',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);
        const codeEl = card.body.elements.find(e => e.content?.includes('```'));
        expect(codeEl!.content).toContain('x'.repeat(297) + '...');
        expect(codeEl!.content).not.toContain('x'.repeat(298));
      });

      it('includes hr separator', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'test',
          permissionId: 'perm-1',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);
        const hrElement = card.body.elements.find(e => e.tag === 'hr');
        expect(hrElement).toBeDefined();
      });
    });

    describe('ask_user_question', () => {
      it('renders blue card with question header', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Which file should I edit?',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('blue');
        expect(card.header.title.content).toContain('Question');
      });

      it('renders question text as markdown element', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Which file should I edit?',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.content === 'Which file should I edit?');
        expect(mdEl).toBeDefined();
      });

      it('renders header when present', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Pick one',
          header: 'User Input Required',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const headerEl = card.body.elements.find(e => e.content?.includes('**User Input Required**'));
        expect(headerEl).toBeDefined();
      });

      it('renders option buttons with indexed callbackData', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Choose:',
          options: [
            { label: 'Option A' },
            { label: 'Option B' },
            { label: 'Option C' },
          ],
          toolUseId: 'tu-42',
        };
        const result = renderer.renderNotification(event);
        // 3 options + 1 skip button
        expect(result.buttons).toHaveLength(4);
        expect(result.buttons![0].callbackData).toBe('askq:tu-42:0');
        expect(result.buttons![0].label).toBe('Option A');
        expect(result.buttons![1].callbackData).toBe('askq:tu-42:1');
        expect(result.buttons![2].callbackData).toBe('askq:tu-42:2');
        expect(result.buttons![3].callbackData).toBe('askq:tu-42:skip');
      });

      it('always includes skip button even without options', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'What next?',
          toolUseId: 'tu-5',
        };
        const result = renderer.renderNotification(event);
        expect(result.buttons).toHaveLength(1);
        expect(result.buttons![0].callbackData).toBe('askq:tu-5:skip');
        expect(result.buttons![0].label).toContain('Skip');
      });
    });

    describe('session_complete', () => {
      it('renders green card with Done header', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'Implemented the feature successfully.',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('green');
        expect(card.header.title.content).toContain('Done');
      });

      it('renders summary with downgraded headings', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: '## Summary\nAll done.',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('**Summary**');
        expect(mdEl!.content).not.toContain('## Summary');
      });

      it('renders cost line when present', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'Done.',
          cost: {
            inputTokens: 1000,
            outputTokens: 500,
            costUsd: 0.05,
            durationMs: 10000,
          },
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const costEl = card.body.elements.find(e => e.content?.includes('$0.05'));
        expect(costEl).toBeDefined();
        expect(costEl!.content).toContain('1.5k tokens');
        expect(costEl!.content).toContain('10s');
      });

      it('includes hr separator before cost', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'Done.',
          cost: {
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.01,
            durationMs: 5000,
          },
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const hrEl = card.body.elements.find(e => e.tag === 'hr');
        expect(hrEl).toBeDefined();
      });

      it('omits cost line when no cost data', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'No cost info.',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const costEl = card.body.elements.find(e => e.content?.includes('$'));
        expect(costEl).toBeUndefined();
      });
    });

    describe('error', () => {
      it('renders red card with error header', () => {
        const event: NotificationEvent = {
          kind: 'error',
          message: 'Connection timeout',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('red');
        expect(card.header.title.content).toContain('Error');
      });

      it('renders error message in code block', () => {
        const event: NotificationEvent = {
          kind: 'error',
          message: 'Connection timeout',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('```');
        expect(mdEl!.content).toContain('Connection timeout');
      });
    });

    describe('todo_update', () => {
      it('renders turquoise card with Progress header', () => {
        const items: TodoItem[] = [
          { content: 'Setup project', status: 'completed' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('turquoise');
        expect(card.header.title.content).toContain('Progress');
      });

      it('renders checklist with status icons', () => {
        const items: TodoItem[] = [
          { content: 'Setup project', status: 'completed' },
          { content: 'Write tests', status: 'in_progress' },
          { content: 'Deploy', status: 'pending' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('\u2705 Setup project');
        expect(mdEl!.content).toContain('\uD83D\uDD27 Write tests');
        expect(mdEl!.content).toContain('\u2B1C Deploy');
      });

      it('renders progress count', () => {
        const items: TodoItem[] = [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
          { content: 'C', status: 'pending' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('Progress (2/3)');
      });
    });

    describe('activity_text', () => {
      it('renders turquoise card with text content', () => {
        const event: NotificationEvent = {
          kind: 'activity_text',
          text: 'Processing file.ts...',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('turquoise');
        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toBe('Processing file.ts...');
      });
    });

    describe('activity_tool', () => {
      it('renders turquoise card with tool name in header and body', () => {
        const event: NotificationEvent = {
          kind: 'activity_tool',
          toolName: 'Read',
          toolInput: 'src/index.ts',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('turquoise');
        expect(card.header.title.content).toContain('Read');

        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('`Read`');
        expect(mdEl!.content).toContain('src/index.ts');
      });

      it('renders without input when not provided', () => {
        const event: NotificationEvent = {
          kind: 'activity_tool',
          toolName: 'Agent',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('`Agent`');
        expect(mdEl!.content).not.toContain('\n');
      });
    });

    describe('thinking', () => {
      it('renders grey card when active', () => {
        const event: NotificationEvent = { kind: 'thinking', active: true };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('grey');
        expect(card.header.title.content).toContain('Thinking');

        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('Thinking...');
      });

      it('renders Done thinking when inactive', () => {
        const event: NotificationEvent = { kind: 'thinking', active: false };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);

        expect(card.header.template).toBe('green');
        expect(card.header.title.content).toContain('Done thinking');
        const mdEl = card.body.elements.find(e => e.tag === 'markdown');
        expect(mdEl!.content).toContain('Done thinking');
      });
    });

    describe('reasoning_summary', () => {
      it('renders grey card with reasoning text', () => {
        const event: NotificationEvent = {
          kind: 'reasoning_summary',
          text: 'reflecting',
          durationMs: 4000,
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);
        expect(card.header.template).toBe('grey');
        expect(card.header.title.content).toContain('Reasoning');
        const mdEl = card.body.elements.find((e: any) => e.tag === 'markdown');
        expect(mdEl!.content).toContain('reflecting');
        expect(mdEl!.content).toContain('4s');
      });

      it('adds truncation note', () => {
        const event: NotificationEvent = {
          kind: 'reasoning_summary',
          text: 'x',
          truncated: true,
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);
        const mdEl = card.body.elements.find((e: any) => e.tag === 'markdown');
        expect(mdEl!.content).toMatch(/truncated/i);
      });
    });

    describe('file_change_list', () => {
      it('renders changes list', () => {
        const event: NotificationEvent = {
          kind: 'file_change_list',
          changes: [
            { path: 'a.ts', kind: 'add' },
            { path: 'b.ts', kind: 'update' },
          ],
          status: 'completed',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);
        expect(card.header.title.content).toContain('File changes');
        const mdEl = card.body.elements.find((e: any) => e.tag === 'markdown');
        expect(mdEl!.content).toContain('a.ts');
        expect(mdEl!.content).toContain('b.ts');
      });

      it('renders failed status with red template', () => {
        const event: NotificationEvent = {
          kind: 'file_change_list',
          changes: [{ path: 'a.ts', kind: 'add' }],
          status: 'failed',
        };
        const result = renderer.renderNotification(event);
        const card = parseCard(result.card);
        expect(card.header.template).toBe('red');
      });
    });
  });

  // ─── renderProgress ─────────────────────────────

  describe('renderProgress', () => {
    function makeSnapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
      return {
        phase: 'executing',
        toolCounts: new Map(),
        totalTools: 0,
        elapsedSeconds: 0,
        responseText: '',
        permissionQueue: [],
        todoItems: [],
        ...overrides,
      };
    }

    describe('starting phase', () => {
      it('renders starting card', () => {
        const result = renderer.renderProgress(makeSnapshot({ phase: 'starting' }));
        const card = parseCard(result.card);

        expect(card.schema).toBe('2.0');
        expect(card.header.title.content).toContain('Starting');
      });
    });

    describe('executing phase', () => {
      it('renders response text with downgraded headings', () => {
        const result = renderer.renderProgress(makeSnapshot({
          responseText: '## Analysis\nSome text here',
        }));
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.content?.includes('Analysis'));
        expect(mdEl).toBeDefined();
        expect(mdEl!.content).toContain('**Analysis**');
        expect(mdEl!.content).not.toContain('## Analysis');
      });

      it('renders tool counts with icons and elapsed time', () => {
        const toolCounts = new Map([['Bash', 3], ['Read', 2]]);
        const result = renderer.renderProgress(makeSnapshot({
          toolCounts,
          totalTools: 5,
          elapsedSeconds: 12,
        }));
        const card = parseCard(result.card);

        const toolEl = card.body.elements.find(e => e.content?.includes('Bash'));
        expect(toolEl).toBeDefined();
        expect(toolEl!.content).toContain('Bash \u00D73');
        expect(toolEl!.content).toContain('Read \u00D72');
        expect(toolEl!.content).toContain('5 tools');
        expect(toolEl!.content).toContain('12s');
      });

      it('renders todo progress', () => {
        const todoItems: TodoItem[] = [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'in_progress' },
        ];
        const result = renderer.renderProgress(makeSnapshot({ todoItems }));
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.content?.includes('Step 1'));
        expect(mdEl).toBeDefined();
        expect(mdEl!.content).toContain('\u2705 Step 1');
        expect(mdEl!.content).toContain('\uD83D\uDD27 Step 2');
        expect(mdEl!.content).toContain('Progress (1/2)');
      });

      it('redacts sensitive content in response text', () => {
        const result = renderer.renderProgress(makeSnapshot({
          responseText: 'Key: sk-proj-ABCDEFGHIJKLMNOP',
        }));
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.content?.includes('sk-proj'));
        expect(mdEl!.content).toContain('sk-proj-[REDACTED]');
        expect(mdEl!.content).not.toContain('ABCDEFGHIJKLMNOP');
      });

      it('renders fallback when no content', () => {
        const result = renderer.renderProgress(makeSnapshot({
          responseText: '',
          totalTools: 0,
        }));
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.content?.includes('Working'));
        expect(mdEl).toBeDefined();
      });
    });

    describe('permission phase', () => {
      it('renders orange card with permission details from queue head', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'permission',
          permissionQueue: [{
            toolName: 'Bash',
            input: 'rm -rf /tmp',
            permId: 'perm-1',
            buttons: [
              { label: '\u2705 Yes', callbackData: 'perm:allow:perm-1', style: 'primary' },
              { label: '\u274C No', callbackData: 'perm:deny:perm-1', style: 'danger' },
            ],
          }],
        }));
        const card = parseCard(result.card);

        expect(card.header.template).toBe('orange');
        expect(card.header.title.content).toContain('Permission Required');

        const toolEl = card.body.elements.find(e => e.content?.includes('Bash'));
        expect(toolEl).toBeDefined();

        const inputEl = card.body.elements.find(e => e.content?.includes('rm -rf /tmp'));
        expect(inputEl).toBeDefined();

        expect(result.buttons).toHaveLength(2);
      });

      it('shows pending count when multiple permissions queued', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'permission',
          permissionQueue: [
            { toolName: 'Bash', input: 'cmd1', permId: 'p1', buttons: [] },
            { toolName: 'Read', input: 'cmd2', permId: 'p2', buttons: [] },
            { toolName: 'Write', input: 'cmd3', permId: 'p3', buttons: [] },
          ],
        }));
        const card = parseCard(result.card);

        const pendingEl = card.body.elements.find(e => e.content?.includes('+2 more pending'));
        expect(pendingEl).toBeDefined();
      });

      it('falls back to starting when queue is empty', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'permission',
          permissionQueue: [],
        }));
        const card = parseCard(result.card);
        expect(card.header.title.content).toContain('Starting');
      });
    });

    describe('completed phase', () => {
      it('renders green card with response text + hr + tool summary + cost', () => {
        const toolCounts = new Map([['Bash', 2], ['Read', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: 'All done!',
          toolCounts,
          totalTools: 3,
          costLine: '\uD83D\uDCCA 1.0k/500 tok | $0.05 | 10s',
        }));
        const card = parseCard(result.card);

        expect(card.header.template).toBe('green');
        expect(card.header.title.content).toContain('Done');

        const textEl = card.body.elements.find(e => e.content?.includes('All done!'));
        expect(textEl).toBeDefined();

        const hrEl = card.body.elements.find(e => e.tag === 'hr');
        expect(hrEl).toBeDefined();

        const toolEl = card.body.elements.find(e => e.content?.includes('Bash'));
        expect(toolEl!.content).toContain('Bash \u00D72');
        expect(toolEl!.content).toContain('Read \u00D71');
        expect(toolEl!.content).toContain('3 total');

        const costEl = card.body.elements.find(e => e.content?.includes('$0.05'));
        expect(costEl).toBeDefined();
      });

      it('omits hr when response is empty', () => {
        const toolCounts = new Map([['Bash', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: '',
          toolCounts,
          totalTools: 1,
          costLine: '\uD83D\uDCCA stats',
        }));
        const card = parseCard(result.card);

        const hrEl = card.body.elements.find(e => e.tag === 'hr');
        expect(hrEl).toBeUndefined();
      });

      it('redacts sensitive content in response text', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: 'Used key sk-proj-ABCDEFGHIJKLMNOP',
          toolCounts: new Map(),
          totalTools: 0,
        }));
        const card = parseCard(result.card);

        const mdEl = card.body.elements.find(e => e.content?.includes('sk-proj'));
        expect(mdEl!.content).toContain('sk-proj-[REDACTED]');
      });
    });

    describe('error phase', () => {
      it('renders red card with error message and response text', () => {
        const toolCounts = new Map([['Bash', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'error',
          responseText: 'Partial response',
          errorMessage: 'stream interrupted',
          toolCounts,
          totalTools: 1,
        }));
        const card = parseCard(result.card);

        expect(card.header.template).toBe('red');
        expect(card.header.title.content).toContain('Error');

        const textEl = card.body.elements.find(e => e.content?.includes('Partial response'));
        expect(textEl).toBeDefined();

        const errorEl = card.body.elements.find(e => e.content?.includes('stream interrupted'));
        expect(errorEl).toBeDefined();

        const hrEl = card.body.elements.find(e => e.tag === 'hr');
        expect(hrEl).toBeDefined();
      });
    });
  });

  // ─── renderCommandResponse ──────────────────────

  describe('renderCommandResponse', () => {
    it('renders card with title in header', () => {
      const data: CommandResponseData = { title: 'Status' };
      const result = renderer.renderCommandResponse(data);
      const card = parseCard(result.card);

      expect(card.header.title.content).toBe('Status');
    });

    it('renders body as markdown element with downgraded headings', () => {
      const data: CommandResponseData = {
        title: 'Help',
        body: '## Commands\nUse `!status` to check status.',
      };
      const result = renderer.renderCommandResponse(data);
      const card = parseCard(result.card);

      const mdEl = card.body.elements.find(e => e.tag === 'markdown');
      expect(mdEl!.content).toContain('**Commands**');
      expect(mdEl!.content).not.toContain('## Commands');
    });

    it('renders fields as bold name + value', () => {
      const data: CommandResponseData = {
        title: 'Info',
        fields: [
          { name: 'Version', value: '1.0.0' },
          { name: 'Status', value: 'running' },
        ],
      };
      const result = renderer.renderCommandResponse(data);
      const card = parseCard(result.card);

      const fieldEl = card.body.elements.find(e => e.content?.includes('**Version:**'));
      expect(fieldEl).toBeDefined();
      expect(fieldEl!.content).toContain('1.0.0');
      expect(fieldEl!.content).toContain('**Status:**');
      expect(fieldEl!.content).toContain('running');
    });

    it('uses correct color for each color option', () => {
      const colors: Array<{ input: CommandResponseData['color']; expected: string }> = [
        { input: 'success', expected: 'green' },
        { input: 'warning', expected: 'orange' },
        { input: 'info', expected: 'blue' },
        { input: 'error', expected: 'red' },
      ];
      for (const { input, expected } of colors) {
        const data: CommandResponseData = { title: 'Test', color: input };
        const result = renderer.renderCommandResponse(data);
        const card = parseCard(result.card);
        expect(card.header.template).toBe(expected);
      }
    });

    it('defaults to blue when no color', () => {
      const data: CommandResponseData = { title: 'Test' };
      const result = renderer.renderCommandResponse(data);
      const card = parseCard(result.card);
      expect(card.header.template).toBe('blue');
    });

    it('passes buttons through', () => {
      const data: CommandResponseData = {
        title: 'Actions',
        buttons: [{ label: 'Click', callbackData: 'action:1' }],
      };
      const result = renderer.renderCommandResponse(data);
      expect(result.buttons).toHaveLength(1);
      expect(result.buttons![0].callbackData).toBe('action:1');
    });

    it('includes hr between body and fields', () => {
      const data: CommandResponseData = {
        title: 'Info',
        body: 'Some body text',
        fields: [{ name: 'Key', value: 'Value' }],
      };
      const result = renderer.renderCommandResponse(data);
      const card = parseCard(result.card);

      const hrEl = card.body.elements.find(e => e.tag === 'hr');
      expect(hrEl).toBeDefined();
    });
  });

  // ─── renderSimpleText ───────────────────────────

  describe('renderSimpleText', () => {
    it('renders turquoise card with text', () => {
      const result = renderer.renderSimpleText('Hello world');
      const card = parseCard(result.card);

      expect(card.schema).toBe('2.0');
      expect(card.header.template).toBe('turquoise');
      const mdEl = card.body.elements.find(e => e.tag === 'markdown');
      expect(mdEl!.content).toBe('Hello world');
    });

    it('returns no buttons', () => {
      const result = renderer.renderSimpleText('test');
      expect(result.buttons).toBeUndefined();
    });

    it('produces valid Card 2.0 JSON', () => {
      const result = renderer.renderSimpleText('valid json test');
      const card = parseCard(result.card);
      expect(card.schema).toBe('2.0');
      expect(card.config.wide_screen_mode).toBe(true);
      expect(card.header).toBeDefined();
      expect(card.body.elements).toBeDefined();
      expect(card.body.elements.length).toBeGreaterThan(0);
    });
  });
});
