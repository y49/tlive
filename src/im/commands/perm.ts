// src/im/commands/perm.ts
//
// `/perm [list|allow <pattern>|deny <pattern>|remove <id>|clear]` — manage
// the per-workspace PermissionBroker auto-resolve policy rules. Delegates to
// the workspace's PolicyStore via ctx.policyStoreFor.
//
// Per spec §3 — no-args UX:
//   /perm                        → list rules + [➕ allow] [➕ deny] [🗑 清空]
//   /perm allow <pattern>        → add allow rule
//   /perm deny <pattern>         → add deny rule
//   /perm remove <id>            → remove rule (alias /perm rm)
//   /perm clear                  → remove all rules
//
// Callback handlers (runtime:perm:add:<verb> / :clear:confirm) wired in
// Task 31.

import type { CommandDef, CommandContext } from '../command-parser.js';
import type { ReplyMarkup, InlineButton } from '../../platform/types.js';
import type { PolicyStore } from '../../permission/policy-store.js';
import { workspaceForChat } from './_shared.js';

export const permCmd: CommandDef = {
  name: 'perm',
  description: 'Session 权限规则',
  async run(ctx, args) {
    const ws = workspaceForChat(ctx);
    if (!ws) {
      await ctx.reply('当前 chat 未绑定工作区,发 /workspace 选一个');
      return;
    }
    const store = ctx.policyStoreFor?.(ws.id);
    if (!store) {
      await ctx.reply('PolicyStore 未配置');
      return;
    }

    const sub = args[0];

    if (!sub || sub === 'list') {
      await renderRules(ctx, store);
      return;
    }
    if (sub === 'allow' || sub === 'deny') {
      // Join remaining args so patterns with spaces (e.g. "Bash(npm test)") work.
      const pattern = args.slice(1).join(' ');
      if (!pattern) {
        await ctx.reply(`用法: /perm ${sub} <toolName>`);
        return;
      }
      const rule = await store.add({ toolName: pattern }, sub, 'workspace', ctx.userId);
      await ctx.reply(`✅ 已添加 ${sub} 规则 ${rule.id}: ${pattern}`);
      return;
    }
    if (sub === 'remove' || sub === 'rm') {
      const id = args[1];
      if (!id) {
        await ctx.reply('用法: /perm remove <id>');
        return;
      }
      const ok = await store.remove(id);
      await ctx.reply(ok ? `✅ 已删除 ${id}` : `❌ 未找到规则 ${id}`);
      return;
    }
    if (sub === 'clear') {
      // PolicyStore has no clear() — iterate + remove.
      const rules = store.list();
      for (const r of rules) await store.remove(r.id);
      await ctx.reply(`✅ 已清空 ${rules.length} 条规则`);
      return;
    }
    await ctx.reply('用法: /perm [list|allow <pattern>|deny <pattern>|remove <id>|clear]');
  },
};

async function renderRules(ctx: CommandContext, store: PolicyStore): Promise<void> {
  const rules = store.list();
  const lines = rules.length === 0
    ? ['📜 暂无权限规则']
    : ['📜 当前权限规则:', ...rules.map((r) => `   • [${r.id}] ${r.decision} ${r.pattern.toolName ?? '*'}`)];

  const buttons: InlineButton[][] = [];
  buttons.push([
    { text: '➕ allow', callbackData: 'runtime:perm:add:allow' },
    { text: '➕ deny', callbackData: 'runtime:perm:add:deny' },
  ]);
  if (rules.length > 0) {
    buttons.push([{ text: '🗑 清空', callbackData: 'runtime:perm:clear:confirm' }]);
  }

  const replyMarkup: ReplyMarkup = { type: 'inline_keyboard', buttons };
  await ctx.reply(lines.join('\n'), { replyMarkup });
}
