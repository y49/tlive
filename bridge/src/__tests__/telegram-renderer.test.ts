import { describe, it, expect } from 'vitest';
import { TelegramRenderer } from '../renderers/telegram.js';
import type {
  NotificationEvent, ProgressSnapshot, CommandResponseData, TodoItem,
} from '../renderers/types.js';

describe('TelegramRenderer', () => {
  const renderer = new TelegramRenderer();

  // ─── channelType ────────────────────────────────

  it('has channelType "telegram"', () => {
    expect(renderer.channelType).toBe('telegram');
  });

  // ─── renderNotification ─────────────────────────

  describe('renderNotification', () => {
    describe('permission_request', () => {
      it('renders permission card with tool name and input', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'npm test -- schema.test.ts',
          permissionId: 'perm-123',
          expiresInMinutes: 5,
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('<b>Permission Required</b>');
        expect(result.html).toContain('<code>Bash</code>');
        expect(result.html).toContain('<pre>npm test -- schema.test.ts</pre>');
        expect(result.html).toContain('Expires in 5 minutes');
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
        // 297 chars + '...' = 300
        expect(result.html).toContain('x'.repeat(297) + '...');
        expect(result.html).not.toContain('x'.repeat(298));
      });

      it('truncates permissionId for 64-byte callback_data limit', () => {
        const longId = 'a'.repeat(100);
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'test',
          permissionId: longId,
        };
        const result = renderer.renderNotification(event);
        // callback_data = "perm:allow:" + id; must be <= 64 bytes
        const allowButton = result.buttons!.find(b => b.callbackData.startsWith('perm:allow:'));
        expect(Buffer.byteLength(allowButton!.callbackData, 'utf8')).toBeLessThanOrEqual(64);
        const denyButton = result.buttons!.find(b => b.callbackData.startsWith('perm:deny:'));
        expect(Buffer.byteLength(denyButton!.callbackData, 'utf8')).toBeLessThanOrEqual(64);
      });

      it('escapes HTML in tool name and input', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: '<script>',
          toolInput: 'echo "<b>hi</b>"',
          permissionId: 'perm-1',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('<code>&lt;script&gt;</code>');
        expect(result.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
        expect(result.html).not.toContain('<script>');
      });

      it('defaults expiresInMinutes to 5', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'test',
          permissionId: 'perm-1',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('Expires in 5 minutes');
      });
    });

    describe('ask_user_question', () => {
      it('renders question text', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Which file should I edit?',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('Which file should I edit?');
      });

      it('renders header when present', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Pick one',
          header: 'User Input Required',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('<b>User Input Required</b>');
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
        expect(result.buttons).toBeDefined();
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

      it('escapes HTML in question text', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Use <b>bold</b> here?',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('&lt;b&gt;bold&lt;/b&gt;');
      });
    });

    describe('session_complete', () => {
      it('renders summary text', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'Implemented the **feature** successfully.',
        };
        const result = renderer.renderNotification(event);
        // markdownToTelegram converts **feature** to <b>feature</b>
        expect(result.html).toContain('<b>feature</b>');
        expect(result.html).toContain('successfully');
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
        expect(result.html).toContain('$0.05');
        expect(result.html).toContain('1.5k tokens');
        expect(result.html).toContain('10s');
      });

      it('omits cost line when no cost data', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'No cost info.',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).not.toContain('$');
        expect(result.html).not.toContain('tokens');
      });
    });

    describe('error', () => {
      it('renders error in pre block', () => {
        const event: NotificationEvent = {
          kind: 'error',
          message: 'Connection timeout',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('<pre>Connection timeout</pre>');
        expect(result.html).toContain('\u274C');
      });

      it('escapes HTML in error message', () => {
        const event: NotificationEvent = {
          kind: 'error',
          message: 'Error: <tag> not found',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('&lt;tag&gt;');
        expect(result.html).not.toContain('<tag>');
      });
    });

    describe('todo_update', () => {
      it('renders checklist with status icons', () => {
        const items: TodoItem[] = [
          { content: 'Setup project', status: 'completed' },
          { content: 'Write tests', status: 'in_progress' },
          { content: 'Deploy', status: 'pending' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('\u2705 Setup project');
        expect(result.html).toContain('\uD83D\uDD27 Write tests');
        expect(result.html).toContain('\u2B1C Deploy');
      });

      it('renders progress count', () => {
        const items: TodoItem[] = [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
          { content: 'C', status: 'pending' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('Progress (2/3)');
      });

      it('escapes HTML in todo content', () => {
        const items: TodoItem[] = [
          { content: 'Fix <br> tag handling', status: 'pending' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('&lt;br&gt;');
      });
    });

    describe('activity_text', () => {
      it('renders escaped plain text', () => {
        const event: NotificationEvent = {
          kind: 'activity_text',
          text: 'Processing <file.ts>...',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toBe('Processing &lt;file.ts&gt;...');
      });
    });

    describe('activity_tool', () => {
      it('renders tool name in code and input', () => {
        const event: NotificationEvent = {
          kind: 'activity_tool',
          toolName: 'Read',
          toolInput: 'src/index.ts',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('\u25B8');
        expect(result.html).toContain('<code>Read</code>');
        expect(result.html).toContain('src/index.ts');
      });

      it('renders without input when not provided', () => {
        const event: NotificationEvent = {
          kind: 'activity_tool',
          toolName: 'Agent',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toBe('\u25B8 <code>Agent</code>');
      });

      it('escapes HTML in tool input', () => {
        const event: NotificationEvent = {
          kind: 'activity_tool',
          toolName: 'Bash',
          toolInput: 'echo "<b>"',
        };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('&lt;b&gt;');
      });
    });

    describe('thinking', () => {
      it('renders thinking indicator when active', () => {
        const event: NotificationEvent = { kind: 'thinking', active: true };
        const result = renderer.renderNotification(event);
        expect(result.html).toContain('\uD83E\uDDE0');
        expect(result.html).toContain('<i>Thinking...</i>');
      });

      it('renders empty string when inactive', () => {
        const event: NotificationEvent = { kind: 'thinking', active: false };
        const result = renderer.renderNotification(event);
        expect(result.html).toBe('');
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
      it('renders starting message', () => {
        const result = renderer.renderProgress(makeSnapshot({ phase: 'starting' }));
        expect(result.html).toBe('\u23F3 Starting...');
      });
    });

    describe('executing phase', () => {
      it('renders response text via markdownToTelegram', () => {
        const result = renderer.renderProgress(makeSnapshot({
          responseText: '**Bold** text here',
        }));
        expect(result.html).toContain('<b>Bold</b>');
        expect(result.html).toContain('text here');
      });

      it('renders tool counts with icons and elapsed time', () => {
        const toolCounts = new Map([['Bash', 3], ['Read', 2]]);
        const result = renderer.renderProgress(makeSnapshot({
          toolCounts,
          totalTools: 5,
          elapsedSeconds: 12,
        }));
        expect(result.html).toContain('\uD83D\uDDA5\uFE0F Bash \u00D73');
        expect(result.html).toContain('\uD83D\uDCD6 Read \u00D72');
        expect(result.html).toContain('5 tools');
        expect(result.html).toContain('12s');
      });

      it('renders todo progress', () => {
        const todoItems: TodoItem[] = [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'in_progress' },
        ];
        const result = renderer.renderProgress(makeSnapshot({ todoItems }));
        expect(result.html).toContain('\u2705 Step 1');
        expect(result.html).toContain('\uD83D\uDD27 Step 2');
        expect(result.html).toContain('Progress (1/2)');
      });

      it('redacts sensitive content in response text', () => {
        const result = renderer.renderProgress(makeSnapshot({
          responseText: 'Key: sk-proj-ABCDEFGHIJKLMNOP',
        }));
        expect(result.html).toContain('sk-proj-[REDACTED]');
        expect(result.html).not.toContain('ABCDEFGHIJKLMNOP');
      });
    });

    describe('permission phase', () => {
      it('renders permission details from queue head', () => {
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
        expect(result.html).toContain('<b>Permission Required</b>');
        expect(result.html).toContain('<code>Bash</code>');
        expect(result.html).toContain('rm -rf /tmp');
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
        expect(result.html).toContain('+2 more pending');
      });

      it('falls back to starting when queue is empty', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'permission',
          permissionQueue: [],
        }));
        expect(result.html).toBe('\u23F3 Starting...');
      });
    });

    describe('completed phase', () => {
      it('renders response text + separator + tool summary + cost', () => {
        const toolCounts = new Map([['Bash', 2], ['Read', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: 'All done!',
          toolCounts,
          totalTools: 3,
          costLine: '\uD83D\uDCCA 1.0k/500 tok | $0.05 | 10s',
        }));
        expect(result.html).toContain('All done!');
        expect(result.html).toContain(SEPARATOR);
        expect(result.html).toContain('Bash \u00D72');
        expect(result.html).toContain('Read \u00D71');
        expect(result.html).toContain('3 total');
        expect(result.html).toContain('$0.05');
      });

      it('omits separator when response is empty', () => {
        const toolCounts = new Map([['Bash', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: '',
          toolCounts,
          totalTools: 1,
          costLine: '\uD83D\uDCCA stats',
        }));
        expect(result.html).not.toContain(SEPARATOR);
        expect(result.html).toContain('Bash');
      });

      it('redacts sensitive content in response text', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: 'Used key sk-proj-ABCDEFGHIJKLMNOP',
          toolCounts: new Map(),
          totalTools: 0,
        }));
        expect(result.html).toContain('sk-proj-[REDACTED]');
      });
    });

    describe('error phase', () => {
      it('renders error message with response text', () => {
        const toolCounts = new Map([['Bash', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'error',
          responseText: 'Partial response',
          errorMessage: 'stream interrupted',
          toolCounts,
          totalTools: 1,
        }));
        expect(result.html).toContain('Partial response');
        expect(result.html).toContain('stream interrupted');
        expect(result.html).toContain(SEPARATOR);
      });
    });
  });

  // ─── renderCommandResponse ──────────────────────

  describe('renderCommandResponse', () => {
    it('renders title in bold', () => {
      const data: CommandResponseData = { title: 'Status' };
      const result = renderer.renderCommandResponse(data);
      expect(result.html).toContain('<b>Status</b>');
    });

    it('renders body via markdownToTelegram', () => {
      const data: CommandResponseData = {
        title: 'Help',
        body: 'Use `!status` to check **status**.',
      };
      const result = renderer.renderCommandResponse(data);
      expect(result.html).toContain('<code>!status</code>');
      expect(result.html).toContain('<b>status</b>');
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
      expect(result.html).toContain('<b>Version:</b> 1.0.0');
      expect(result.html).toContain('<b>Status:</b> running');
    });

    it('escapes HTML in title and field values', () => {
      const data: CommandResponseData = {
        title: '<script>alert</script>',
        fields: [{ name: 'Key', value: '<b>raw</b>' }],
      };
      const result = renderer.renderCommandResponse(data);
      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).toContain('&lt;b&gt;raw&lt;/b&gt;');
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
  });

  // ─── renderSimpleText ───────────────────────────

  describe('renderSimpleText', () => {
    it('escapes HTML entities', () => {
      const result = renderer.renderSimpleText('a < b & c > d');
      expect(result.html).toBe('a &lt; b &amp; c &gt; d');
    });

    it('returns plain escaped text without buttons', () => {
      const result = renderer.renderSimpleText('Hello world');
      expect(result.html).toBe('Hello world');
      expect(result.buttons).toBeUndefined();
    });
  });
});

const SEPARATOR = '\u2500'.repeat(15);
