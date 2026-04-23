// src/im/commands/mcp.ts
//
// `/mcp [list|add <json>|remove <n>|reconnect <n>|toggle <n> on|off|install <name>]`
// — manage downstream MCP servers via the McpRegistry + runtime bridge.

import type { CommandDef } from '../command-parser.js';
import type { McpServerConfig } from '../../runtime/types.js';
import { activeLocalSession } from './_shared.js';

export const mcpCmd: CommandDef = {
  name: 'mcp',
  role: ['admin', 'operator'],
  description: 'Manage MCP servers',
  async run(ctx, args) {
    const sub = args[0] ?? 'list';
    const registry = ctx.mcpRegistry;
    if (!registry) { await ctx.reply('McpRegistry not wired (TODO T9).'); return; }

    if (sub === 'list') {
      const entries = registry.list();
      if (entries.length === 0) { await ctx.reply('(no MCP servers registered)'); return; }
      const lines = entries.map((e) => `• ${e.name} [${e.enabled ? 'on' : 'off'}] ${e.config.type ?? 'stdio'}`);
      await ctx.reply(['MCP servers:', ...lines].join('\n'));
      return;
    }
    if (sub === 'add') {
      const json = args.slice(1).join(' ');
      if (!json) { await ctx.reply('Usage: /mcp add <json>'); return; }
      let config: { name: string; config: McpServerConfig };
      try { config = JSON.parse(json) as { name: string; config: McpServerConfig }; }
      catch { await ctx.reply('Invalid JSON for /mcp add.'); return; }
      await registry.add({ name: config.name, config: config.config, enabled: true });
      await ctx.reply(`Added MCP server ${config.name}.`);
      return;
    }
    if (sub === 'remove') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /mcp remove <name>'); return; }
      const ok = await registry.remove(name);
      await ctx.reply(ok ? `Removed ${name}.` : `No MCP server named '${name}'.`);
      return;
    }
    if (sub === 'reconnect') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /mcp reconnect <name>'); return; }
      const session = await activeLocalSession(ctx);
      if (!session) return;
      await session.reconnectMcpServer(name);
      await ctx.reply(`Reconnecting ${name}...`);
      return;
    }
    if (sub === 'toggle') {
      const name = args[1];
      const state = args[2];
      if (!name || (state !== 'on' && state !== 'off')) {
        await ctx.reply('Usage: /mcp toggle <name> on|off'); return;
      }
      const ok = await registry.setEnabled(name, state === 'on');
      if (!ok) { await ctx.reply(`No MCP server named '${name}'.`); return; }
      const session = await activeLocalSession(ctx).catch(() => null);
      if (session) await session.toggleMcpServer(name, state === 'on');
      await ctx.reply(`${name} ${state}.`);
      return;
    }
    if (sub === 'install') {
      const name = args[1];
      if (!name) { await ctx.reply('Usage: /mcp install <name>'); return; }
      await ctx.reply(`Install hook for ${name} not yet wired (TODO T9).`);
      return;
    }
    await ctx.reply('Usage: /mcp [list|add|remove|reconnect|toggle|install]');
  },
};
