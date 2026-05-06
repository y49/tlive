import { describe, it, expect } from 'vitest';
import { permCmd } from '../../../src/im/commands/perm.js';
import { buildCtx } from './_helpers.js';
import type { PolicyStore, PolicyRule } from '../../../src/permission/policy-store.js';

function makeStubPolicyStore(): PolicyStore {
  let rules: PolicyRule[] = [];
  let counter = 0;
  return {
    list: () => [...rules],
    add: async (
      pattern: PolicyRule['pattern'],
      decision: PolicyRule['decision'],
      scope: PolicyRule['scope'],
      createdBy: string,
    ): Promise<PolicyRule> => {
      const rule: PolicyRule = {
        id: `r${++counter}`,
        pattern,
        decision,
        scope,
        createdBy,
        createdAt: new Date().toISOString(),
      };
      rules.push(rule);
      return rule;
    },
    remove: async (id: string): Promise<boolean> => {
      const before = rules.length;
      rules = rules.filter((r) => r.id !== id);
      return rules.length < before;
    },
  } as unknown as PolicyStore;
}

describe('/perm', () => {
  it('no args: lists rules + add buttons', async () => {
    const store = makeStubPolicyStore();
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, []);
    expect(replies[0]).toMatch(/暂无权限规则/);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    expect(labels).toContain('➕ allow');
    expect(labels).toContain('➕ deny');
    // No 清空 button when there are no rules.
    expect(labels).not.toContain('🗑 清空');
    // Callback data for add buttons.
    const allowBtn = (replyMarkups[0]!.buttons!).flat().find((b) => b.text === '➕ allow');
    expect(allowBtn?.callbackData).toBe('runtime:perm:add:allow');
  });

  it('list with rules shows them + clear button', async () => {
    const store = makeStubPolicyStore();
    await store.add({ toolName: 'Bash' }, 'allow', 'workspace', 'u1');
    await store.add({ toolName: 'Read' }, 'deny', 'workspace', 'u1');
    const { ctx, replies, replyMarkups } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, []);
    expect(replies[0]).toMatch(/Bash/);
    expect(replies[0]).toMatch(/Read/);
    const labels = (replyMarkups[0]!.buttons!).flat().map((b) => b.text);
    expect(labels).toContain('🗑 清空');
    const clearBtn = (replyMarkups[0]!.buttons!).flat().find((b) => b.text === '🗑 清空');
    expect(clearBtn?.callbackData).toBe('runtime:perm:clear:confirm');
  });

  it('explicit list arg: same as no-args', async () => {
    const store = makeStubPolicyStore();
    await store.add({ toolName: 'Bash' }, 'allow', 'workspace', 'u1');
    const { ctx, replies } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/Bash/);
  });

  it('allow <pattern>: adds rule', async () => {
    const store = makeStubPolicyStore();
    const { ctx, replies } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['allow', 'Bash']);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.decision).toBe('allow');
    expect(store.list()[0]!.pattern.toolName).toBe('Bash');
    expect(replies[0]).toMatch(/已添加.*allow/);
  });

  it('deny <pattern>: adds rule', async () => {
    const store = makeStubPolicyStore();
    const { ctx } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['deny', 'Read']);
    expect(store.list()[0]!.decision).toBe('deny');
  });

  it('allow without pattern: usage hint', async () => {
    const store = makeStubPolicyStore();
    const { ctx, replies } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['allow']);
    expect(replies[0]).toMatch(/用法.*allow/);
  });

  it('remove <id>: removes existing rule', async () => {
    const store = makeStubPolicyStore();
    const r = await store.add({ toolName: 'Bash' }, 'allow', 'workspace', 'u1');
    const { ctx, replies } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['remove', r.id]);
    expect(store.list()).toHaveLength(0);
    expect(replies[0]).toMatch(/已删除/);
  });

  it('remove <id>: missing id reports not-found', async () => {
    const store = makeStubPolicyStore();
    const { ctx, replies } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['remove', 'nope']);
    expect(replies[0]).toMatch(/未找到/);
  });

  it('rm alias for remove', async () => {
    const store = makeStubPolicyStore();
    const r = await store.add({ toolName: 'Bash' }, 'allow', 'workspace', 'u1');
    const { ctx, replies } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['rm', r.id]);
    expect(replies[0]).toMatch(/已删除/);
  });

  it('clear: removes all rules', async () => {
    const store = makeStubPolicyStore();
    await store.add({ toolName: 'Bash' }, 'allow', 'workspace', 'u1');
    await store.add({ toolName: 'Read' }, 'deny', 'workspace', 'u1');
    const { ctx, replies } = buildCtx({
      workspace: { id: 'ws-1' },
      policyStoreFor: () => store,
    });
    await permCmd.run(ctx, ['clear']);
    expect(store.list()).toHaveLength(0);
    expect(replies[0]).toMatch(/已清空 2/);
  });

  it('reports missing store', async () => {
    const { ctx, replies } = buildCtx();
    await permCmd.run(ctx, ['list']);
    expect(replies[0]).toMatch(/PolicyStore 未配置/);
  });

  it('no workspace: friendly prompt', async () => {
    const { ctx, replies } = buildCtx({ workspace: null });
    await permCmd.run(ctx, []);
    expect(replies[0]).toMatch(/未绑定/);
  });
});
