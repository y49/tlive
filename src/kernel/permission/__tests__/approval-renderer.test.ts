import { describe, it, expect } from 'vitest';
import { renderApprovalCard, maskSecrets } from '../approval-renderer';

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

  it('separates description from the command block with a blank line', () => {
    const { body } = renderApprovalCard({ toolName: 'Bash', input: { command: 'ls', description: 'List' } });
    expect(body).toBe('*List*\n\n```bash\nls\n```');
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
