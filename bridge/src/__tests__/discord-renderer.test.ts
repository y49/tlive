import { describe, it, expect } from 'vitest';
import { DiscordRenderer } from '../renderers/discord.js';
import type {
  NotificationEvent, ProgressSnapshot, CommandResponseData, TodoItem,
} from '../renderers/types.js';

describe('DiscordRenderer', () => {
  const renderer = new DiscordRenderer();

  // ─── channelType ────────────────────────────────

  it('has channelType "discord"', () => {
    expect(renderer.channelType).toBe('discord');
  });

  // ─── renderNotification ─────────────────────────

  describe('renderNotification', () => {
    describe('permission_request', () => {
      it('renders embed with orange color and permission title', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'npm test -- schema.test.ts',
          permissionId: 'perm-123',
          expiresInMinutes: 5,
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.title).toContain('Permission Required');
        expect(result.embed.color).toBe(0xFFA500);
        expect(result.embed.description).toContain('```\nnpm test -- schema.test.ts\n```');
      });

      it('includes tool name and expiry in fields', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'rm -rf /',
          permissionId: 'perm-abc',
          expiresInMinutes: 3,
        };
        const result = renderer.renderNotification(event);
        const toolField = result.embed.fields?.find(f => f.name.includes('Tool'));
        expect(toolField).toBeDefined();
        expect(toolField!.value).toContain('Bash');
        const expiryField = result.embed.fields?.find(f => f.name.includes('Expires'));
        expect(expiryField).toBeDefined();
        expect(expiryField!.value).toContain('3 min');
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
        expect(result.embed.description).toContain('x'.repeat(297) + '...');
        expect(result.embed.description).not.toContain('x'.repeat(298));
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
        const allowButton = result.buttons!.find(b => b.callbackData.startsWith('perm:allow:'));
        expect(Buffer.byteLength(allowButton!.callbackData, 'utf8')).toBeLessThanOrEqual(64);
        const denyButton = result.buttons!.find(b => b.callbackData.startsWith('perm:deny:'));
        expect(Buffer.byteLength(denyButton!.callbackData, 'utf8')).toBeLessThanOrEqual(64);
      });

      it('defaults expiresInMinutes to 5', () => {
        const event: NotificationEvent = {
          kind: 'permission_request',
          toolName: 'Bash',
          toolInput: 'test',
          permissionId: 'perm-1',
        };
        const result = renderer.renderNotification(event);
        const expiryField = result.embed.fields?.find(f => f.name.includes('Expires'));
        expect(expiryField!.value).toContain('5 min');
      });
    });

    describe('ask_user_question', () => {
      it('renders embed with blue color and question', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Which file should I edit?',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0x3399FF);
        expect(result.embed.description).toContain('Which file should I edit?');
      });

      it('renders header when present', () => {
        const event: NotificationEvent = {
          kind: 'ask_user_question',
          question: 'Pick one',
          header: 'User Input Required',
          toolUseId: 'tu-1',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toContain('**User Input Required**');
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
    });

    describe('session_complete', () => {
      it('renders embed with green color and summary', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'Implemented the feature successfully.',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0x00CC66);
        expect(result.embed.title).toContain('Session Complete');
        expect(result.embed.description).toContain('Implemented the feature successfully.');
      });

      it('wraps summary in code block when >500 chars', () => {
        const longSummary = 'a'.repeat(600);
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: longSummary,
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toContain('```\n');
        // 497 chars + '...' = 500
        expect(result.embed.description).toContain('a'.repeat(497) + '...');
      });

      it('does not wrap short summary in code block', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'Done quickly.',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toBe('Done quickly.');
        expect(result.embed.description).not.toContain('```');
      });

      it('renders cost in footer when present', () => {
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
        expect(result.embed.footer).toContain('$0.05');
        expect(result.embed.footer).toContain('1.5k tokens');
        expect(result.embed.footer).toContain('10s');
      });

      it('omits footer when no cost data', () => {
        const event: NotificationEvent = {
          kind: 'session_complete',
          summary: 'No cost info.',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.footer).toBeUndefined();
      });
    });

    describe('error', () => {
      it('renders embed with red color and error in code block', () => {
        const event: NotificationEvent = {
          kind: 'error',
          message: 'Connection timeout',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0xFF4444);
        expect(result.embed.title).toContain('Error');
        expect(result.embed.description).toBe('```\nConnection timeout\n```');
      });
    });

    describe('todo_update', () => {
      it('renders embed with turquoise color and checklist', () => {
        const items: TodoItem[] = [
          { content: 'Setup project', status: 'completed' },
          { content: 'Write tests', status: 'in_progress' },
          { content: 'Deploy', status: 'pending' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0x00CED1);
        expect(result.embed.description).toContain('\u2705 Setup project');
        expect(result.embed.description).toContain('\uD83D\uDD27 Write tests');
        expect(result.embed.description).toContain('\u2B1C Deploy');
      });

      it('renders progress count', () => {
        const items: TodoItem[] = [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
          { content: 'C', status: 'pending' },
        ];
        const event: NotificationEvent = { kind: 'todo_update', items };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toContain('Progress (2/3)');
      });
    });

    describe('activity_text', () => {
      it('renders embed with gray color and text', () => {
        const event: NotificationEvent = {
          kind: 'activity_text',
          text: 'Processing file...',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0x888888);
        expect(result.embed.description).toBe('Processing file...');
      });
    });

    describe('activity_tool', () => {
      it('renders tool name and input with arrow', () => {
        const event: NotificationEvent = {
          kind: 'activity_tool',
          toolName: 'Read',
          toolInput: 'src/index.ts',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0x888888);
        expect(result.embed.description).toContain('\u25B8');
        expect(result.embed.description).toContain('Read');
        expect(result.embed.description).toContain('src/index.ts');
      });

      it('renders without input when not provided', () => {
        const event: NotificationEvent = {
          kind: 'activity_tool',
          toolName: 'Agent',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toBe('\u25B8 Agent');
      });
    });

    describe('thinking', () => {
      it('renders thinking indicator when active', () => {
        const event: NotificationEvent = { kind: 'thinking', active: true };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0x888888);
        expect(result.embed.description).toContain('\uD83E\uDDE0');
        expect(result.embed.description).toContain('Thinking...');
      });

      it('renders Done thinking when inactive', () => {
        const event: NotificationEvent = { kind: 'thinking', active: false };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toContain('Done thinking');
        expect(result.embed.color).toBe(0x00CC66);
      });
    });

    describe('reasoning_summary', () => {
      it('renders reasoning with spoiler markdown and duration', () => {
        const event: NotificationEvent = {
          kind: 'reasoning_summary',
          text: 'thinking carefully',
          durationMs: 3000,
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toContain('||');
        expect(result.embed.description).toContain('thinking carefully');
        expect(result.embed.description).toContain('3s');
      });

      it('adds truncation note', () => {
        const event: NotificationEvent = {
          kind: 'reasoning_summary',
          text: 'x',
          truncated: true,
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toMatch(/truncated|web terminal/i);
      });
    });

    describe('file_change_list', () => {
      it('renders changes list with markers', () => {
        const event: NotificationEvent = {
          kind: 'file_change_list',
          changes: [
            { path: 'a.ts', kind: 'add' },
            { path: 'b.ts', kind: 'update' },
            { path: 'c.ts', kind: 'delete' },
          ],
          status: 'completed',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.description).toContain('a.ts');
        expect(result.embed.description).toContain('b.ts');
        expect(result.embed.description).toContain('c.ts');
      });

      it('renders failed status with red color', () => {
        const event: NotificationEvent = {
          kind: 'file_change_list',
          changes: [{ path: 'a.ts', kind: 'add' }],
          status: 'failed',
        };
        const result = renderer.renderNotification(event);
        expect(result.embed.color).toBe(0xcc3333);
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
      it('renders starting embed', () => {
        const result = renderer.renderProgress(makeSnapshot({ phase: 'starting' }));
        expect(result.embed.description).toContain('Starting...');
      });
    });

    describe('executing phase', () => {
      it('renders response text in description', () => {
        const result = renderer.renderProgress(makeSnapshot({
          responseText: 'Working on **feature**',
        }));
        // Discord supports markdown natively — no conversion needed
        expect(result.embed.description).toContain('Working on **feature**');
      });

      it('renders tool counts with icons and elapsed time in footer', () => {
        const toolCounts = new Map([['Bash', 3], ['Read', 2]]);
        const result = renderer.renderProgress(makeSnapshot({
          toolCounts,
          totalTools: 5,
          elapsedSeconds: 12,
        }));
        expect(result.embed.footer).toContain('Bash \u00D73');
        expect(result.embed.footer).toContain('Read \u00D72');
        expect(result.embed.footer).toContain('5 tools');
        expect(result.embed.footer).toContain('12s');
      });

      it('renders todo progress in description', () => {
        const todoItems: TodoItem[] = [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'in_progress' },
        ];
        const result = renderer.renderProgress(makeSnapshot({ todoItems }));
        expect(result.embed.description).toContain('\u2705 Step 1');
        expect(result.embed.description).toContain('\uD83D\uDD27 Step 2');
        expect(result.embed.description).toContain('Progress (1/2)');
      });

      it('redacts sensitive content in response text', () => {
        const result = renderer.renderProgress(makeSnapshot({
          responseText: 'Key: sk-proj-ABCDEFGHIJKLMNOP',
        }));
        expect(result.embed.description).toContain('sk-proj-[REDACTED]');
        expect(result.embed.description).not.toContain('ABCDEFGHIJKLMNOP');
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
        expect(result.embed.title).toContain('Permission Required');
        expect(result.embed.color).toBe(0xFFA500);
        expect(result.embed.description).toContain('rm -rf /tmp');
        const toolField = result.embed.fields?.find(f => f.name.includes('Tool'));
        expect(toolField!.value).toContain('Bash');
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
        const pendingField = result.embed.fields?.find(f => f.name.includes('Pending'));
        expect(pendingField).toBeDefined();
        expect(pendingField!.value).toContain('+2 more');
      });

      it('falls back to starting when queue is empty', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'permission',
          permissionQueue: [],
        }));
        expect(result.embed.description).toContain('Starting...');
      });
    });

    describe('completed phase', () => {
      it('renders response text, tool summary in footer, cost in footer', () => {
        const toolCounts = new Map([['Bash', 2], ['Read', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: 'All done!',
          toolCounts,
          totalTools: 3,
          costLine: '\uD83D\uDCCA 1.0k/500 tok | $0.05 | 10s',
        }));
        expect(result.embed.description).toContain('All done!');
        expect(result.embed.footer).toContain('Bash \u00D72');
        expect(result.embed.footer).toContain('Read \u00D71');
        expect(result.embed.footer).toContain('3 total');
        expect(result.embed.footer).toContain('$0.05');
        expect(result.embed.color).toBe(0x00CC66);
      });

      it('omits description when response is empty', () => {
        const toolCounts = new Map([['Bash', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: '',
          toolCounts,
          totalTools: 1,
          costLine: '\uD83D\uDCCA stats',
        }));
        expect(result.embed.description).toBeUndefined();
        expect(result.embed.footer).toContain('Bash');
      });

      it('redacts sensitive content in response text', () => {
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'completed',
          responseText: 'Used key sk-proj-ABCDEFGHIJKLMNOP',
          toolCounts: new Map(),
          totalTools: 0,
        }));
        expect(result.embed.description).toContain('sk-proj-[REDACTED]');
      });
    });

    describe('error phase', () => {
      it('renders with red color and error message in field', () => {
        const toolCounts = new Map([['Bash', 1]]);
        const result = renderer.renderProgress(makeSnapshot({
          phase: 'error',
          responseText: 'Partial response',
          errorMessage: 'stream interrupted',
          toolCounts,
          totalTools: 1,
        }));
        expect(result.embed.color).toBe(0xFF4444);
        expect(result.embed.description).toContain('Partial response');
        const errorField = result.embed.fields?.find(f => f.name.includes('Error'));
        expect(errorField).toBeDefined();
        expect(errorField!.value).toContain('stream interrupted');
      });
    });
  });

  // ─── renderCommandResponse ──────────────────────

  describe('renderCommandResponse', () => {
    it('renders title in embed', () => {
      const data: CommandResponseData = { title: 'Status' };
      const result = renderer.renderCommandResponse(data);
      expect(result.embed.title).toBe('Status');
    });

    it('renders body as description', () => {
      const data: CommandResponseData = {
        title: 'Help',
        body: 'Use `!status` to check **status**.',
      };
      const result = renderer.renderCommandResponse(data);
      // Discord supports markdown natively — no conversion needed
      expect(result.embed.description).toContain('`!status`');
      expect(result.embed.description).toContain('**status**');
    });

    it('renders fields', () => {
      const data: CommandResponseData = {
        title: 'Info',
        fields: [
          { name: 'Version', value: '1.0.0' },
          { name: 'Status', value: 'running', inline: true },
        ],
      };
      const result = renderer.renderCommandResponse(data);
      expect(result.embed.fields).toHaveLength(2);
      expect(result.embed.fields![0]).toEqual({ name: 'Version', value: '1.0.0', inline: undefined });
      expect(result.embed.fields![1]).toEqual({ name: 'Status', value: 'running', inline: true });
    });

    it('maps color hint to Discord color codes', () => {
      expect(renderer.renderCommandResponse({ title: 'T', color: 'success' }).embed.color).toBe(0x00CC66);
      expect(renderer.renderCommandResponse({ title: 'T', color: 'warning' }).embed.color).toBe(0xFFA500);
      expect(renderer.renderCommandResponse({ title: 'T', color: 'info' }).embed.color).toBe(0x3399FF);
      expect(renderer.renderCommandResponse({ title: 'T', color: 'error' }).embed.color).toBe(0xFF4444);
    });

    it('defaults to gray when no color hint', () => {
      const result = renderer.renderCommandResponse({ title: 'T' });
      expect(result.embed.color).toBe(0x888888);
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
    it('renders text as embed description', () => {
      const result = renderer.renderSimpleText('Hello world');
      expect(result.embed.description).toBe('Hello world');
    });

    it('returns embed without buttons', () => {
      const result = renderer.renderSimpleText('Hello world');
      expect(result.buttons).toBeUndefined();
    });

    it('preserves markdown in text (Discord native)', () => {
      const result = renderer.renderSimpleText('**bold** and `code`');
      expect(result.embed.description).toBe('**bold** and `code`');
    });
  });
});
