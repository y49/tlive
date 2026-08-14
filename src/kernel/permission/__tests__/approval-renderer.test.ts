import { describe, it, expect } from 'vitest';
import { renderApprovalCard, maskSecrets, summarizeToolCall } from '../approval-renderer';

describe('maskSecrets', () => {
  it('masks URL query token/key/password params', () => {
    expect(maskSecrets('curl https://x.com/a?token=abc123&z=1')).toContain('token=***');
    expect(maskSecrets('curl https://x.com/a?token=abc123&z=1')).toContain('z=1');
  });
  it('masks export FOO_KEY=... assignments', () => {
    expect(maskSecrets('export OPENAI_API_KEY=sk-secret')).toBe('export OPENAI_API_KEY=***');
  });
  it('masks Bearer tokens and JSON secret values', () => {
    expect(maskSecrets('curl -H "Authorization: Bearer sk-live-abc"')).toContain('Bearer ***');
    expect(maskSecrets('{"token":"ghp_xxx","q":1}')).toContain('"token":"***"');
    expect(maskSecrets('{"token":"ghp_xxx","q":1}')).toContain('"q":1');
  });
});

describe('renderApprovalCard', () => {
  it('Edit → unified diff of old→new', () => {
    const { title, body } = renderApprovalCard({ toolName: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } });
    expect(title).toBe('Edit');
    expect(body).toContain('/a.ts');
    expect(body).toContain('- x');
    expect(body).toContain('+ y');
  });
  it('Write → file path + content preview', () => {
    const { body } = renderApprovalCard({ toolName: 'Write', input: { file_path: '/b.txt', content: 'hello' } });
    expect(body).toContain('/b.txt');
    expect(body).toContain('hello');
  });
  it('Bash → command block, flags risky commands, masks secrets', () => {
    const risky = renderApprovalCard({ toolName: 'Bash', input: { command: 'rm -rf /tmp/x', description: 'clean' } });
    expect(risky.body).toContain('clean');
    expect(risky.body).toContain('rm -rf /tmp/x');
    expect(risky.body).toContain('Risky');
    expect(risky.body).toContain('rm -rf');
    const secret = renderApprovalCard({ toolName: 'Bash', input: { command: 'curl h?token=abc' } });
    expect(secret.body).toContain('token=***');
  });
  it('Bash → shows the Codex "reason" as the description line when no description is present', () => {
    // Codex commandExecution approvals pass `reason` (not `description`); surface it.
    const { body } = renderApprovalCard({ toolName: 'Bash', input: { command: 'npm test', reason: 'Run the suite before merging' } });
    expect(body).toContain('Run the suite before merging');
  });
  it('unknown/MCP tool → masked key:value summary (not raw JSON)', () => {
    const { body } = renderApprovalCard({ toolName: 'mcp__s__t', input: { password: 'p', q: 1 } });
    expect(body).toContain('password: ***');
    expect(body).toContain('q: 1');
    expect(body).not.toContain('{"');
  });
  it('apply_patch(Codex 编辑)渲染成 diff', () => {
    const { body } = renderApprovalCard({ toolName: 'apply_patch', input: { command: '*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch' } });
    expect(body).toContain('```diff');
    expect(body).toContain('+new');
    expect(body).toContain('-old');
  });
});

describe('emoji allowlist', () => {
  it('title carries no tool icon', () => {
    expect(renderApprovalCard({ toolName: 'Bash', input: { command: 'ls' } }).title).toBe('Bash');
    expect(renderApprovalCard({ toolName: 'Edit', input: { file_path: '/a' } }).title).toBe('Edit');
    expect(renderApprovalCard({ toolName: 'mcp__x__y', input: {} }).title).toBe('mcp__x__y');
  });

  it('keeps the risk warning emoji — it carries information', () => {
    const { body } = renderApprovalCard({ toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } });
    expect(body).toContain('⚠️ **Risky** — rm -rf');
  });

  it('B spacing: leading blank line (title breathes) + blank line after description', () => {
    const { body } = renderApprovalCard({ toolName: 'Bash', input: { command: 'ls', description: 'List' } });
    // 前导 \n → 标题后空行;desc 后 \n\n → 描述后空行(经 mdToTelegramHtml 成 B 布局)
    expect(body).toBe('\n*List*\n\n```bash\nls\n```');
  });

  it('B spacing: no description still breathes below the title (leading \\n\\n)', () => {
    const { body } = renderApprovalCard({ toolName: 'Bash', input: { command: 'ls' } });
    expect(body).toBe('\n\n```bash\nls\n```');
  });

  it('B spacing: Edit puts a blank line after the file path', () => {
    const { body } = renderApprovalCard({ toolName: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } });
    expect(body).toBe('\n`/a.ts`\n\n```diff\n- x\n+ y\n```');
  });
});

describe('approval-card fence spoofing defense', () => {
  it('breaks embedded triple-backticks in Bash description + command', () => {
    const { body } = renderApprovalCard({ toolName: 'Bash', input: { command: 'rm -rf ~', description: 'safe\n```bash\nls\n```' } });
    // the ONLY real fences are the ones the renderer opens; agent ``` are broken
    const fences = (body.match(/```/g) ?? []).length;
    expect(fences).toBe(2); // just the bash fence we opened
    expect(body).toContain('rm -rf ~');
  });
  it('neutralizes backticks in an inline file_path span', () => {
    const { body } = renderApprovalCard({ toolName: 'Write', input: { file_path: 'a`b`c', content: 'x' } });
    expect(body).not.toContain('a`b`c');
  });
});

describe('summarizeToolCall', () => {
  it('Bash: the command, collapsed onto one line', () => {
    expect(summarizeToolCall('Bash', { command: 'pnpm build' })).toBe('Bash · pnpm build');
    expect(summarizeToolCall('Bash', { command: 'a \n  b\tc' })).toBe('Bash · a b c');
  });

  it('file tools: the basename, not the whole path — the body is two lines wide', () => {
    expect(summarizeToolCall('Edit', { file_path: '/home/y/proj/src/kernel/daemon/bootstrap.ts' }))
      .toBe('Edit · bootstrap.ts');
    expect(summarizeToolCall('Write', { file_path: '/tmp/out.json' })).toBe('Write · out.json');
    expect(summarizeToolCall('Read', { file_path: '/tmp/out.json' })).toBe('Read · out.json');
    expect(summarizeToolCall('NotebookEdit', { notebook_path: '/n/a.ipynb' })).toBe('NotebookEdit · a.ipynb');
  });

  it('search tools: the pattern', () => {
    expect(summarizeToolCall('Grep', { pattern: 'TODO' })).toBe('Grep · TODO');
    expect(summarizeToolCall('Glob', { pattern: '**/*.ts' })).toBe('Glob · **/*.ts');
  });

  it('apply_patch: the first file the patch touches', () => {
    const command = '*** Begin Patch\n*** Update File: src/kernel/daemon/bootstrap.ts\n@@\n-a\n+b\n*** End Patch';
    expect(summarizeToolCall('apply_patch', { command })).toBe('apply_patch · bootstrap.ts');
  });

  it('WebFetch: the host only', () => {
    expect(summarizeToolCall('WebFetch', { url: 'https://example.com/a/b?token=abc' }))
      .toBe('WebFetch · example.com');
  });

  it('Task: the agent description', () => {
    expect(summarizeToolCall('Task', { description: 'Audit the retry paths' }))
      .toBe('Task · Audit the retry paths');
  });

  it('AskUserQuestion names the question, not itself — a body reading "AskUserQuestion" tells you nothing you did not already know', () => {
    const input = { questions: [{ question: 'Which auth method should the worker use?', header: 'Auth method', options: [{ label: 'OIDC' }], multiSelect: false }] };
    expect(summarizeToolCall('AskUserQuestion', input)).toBe('AskUserQuestion · Auth method');
  });

  it('AskUserQuestion falls back to the question text when there is no header, and to its own name when there are no questions', () => {
    expect(summarizeToolCall('AskUserQuestion', { questions: [{ question: 'Ship it?', options: [], multiSelect: false }] }))
      .toBe('AskUserQuestion · Ship it?');
    expect(summarizeToolCall('AskUserQuestion', { questions: [] })).toBe('AskUserQuestion');
    expect(summarizeToolCall('AskUserQuestion', {})).toBe('AskUserQuestion');
  });

  it('an unknown tool, or a known one with nothing to name, degrades to the tool name alone', () => {
    expect(summarizeToolCall('mcp__weird__thing', { a: 1 })).toBe('mcp__weird__thing');
    expect(summarizeToolCall('Bash', {})).toBe('Bash');
    expect(summarizeToolCall('Edit', null)).toBe('Edit');
  });

  it('does NOT mask or truncate — renderWaiting owns both, so every body gets them', () => {
    const long = 'x'.repeat(200);
    expect(summarizeToolCall('Bash', { command: `TOKEN=abc123 ${long}` }))
      .toBe(`Bash · TOKEN=abc123 ${long}`);
  });
});
