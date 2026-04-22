// src/runtime/claude/control.ts
//
// Wraps the @anthropic-ai/claude-agent-sdk Query + top-level session helpers
// in a tlive-facing control face. Translates SDK-native shapes into the
// AgentRuntime-defined ones (ModelInfo.value -> id, AccountInfo.subscriptionType
// -> subscription, McpSetServersResult.errors record -> failed[], etc.).

import type {
  Query,
  PermissionMode as SdkPermissionMode,
  McpServerConfig as SdkMcpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import {
  forkSession as sdkForkSession,
  renameSession as sdkRenameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SlashCommandInfo, ModelInfo, AgentInfo, McpServerStatus,
  ContextUsage, AccountInfo, RewindResult, McpServerConfig, McpSetServersResult,
  PermissionMode,
} from '../types.js';
import { UnsupportedByRuntimeError } from '../abstractions.js';

export interface ClaudeControlFace {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyPermissionRules(rules: { allow?: string[]; deny?: string[] }): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  supportedCommands(): Promise<SlashCommandInfo[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  getContextUsage(): Promise<ContextUsage>;
  accountInfo(): Promise<AccountInfo>;
  forkSession(title?: string): Promise<{ sdkSessionId: string }>;
  renameSession(sdkSessionId: string, title: string): Promise<void>;
  rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }): Promise<RewindResult>;
  reloadPlugins(): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  reconnectMcpServer(name: string): Promise<void>;
  toggleMcpServer(name: string, enabled: boolean): Promise<void>;
}

export function makeClaudeControlFace(
  getQuery: () => Query | null,
  getSdkSessionId: () => string | null,
): ClaudeControlFace {
  const req = (): Query => {
    const q = getQuery();
    if (!q) throw new UnsupportedByRuntimeError('claude', 'control face called before start');
    return q;
  };

  return {
    interrupt: async () => { await req().interrupt(); },
    setModel: async (model) => { await req().setModel(model); },
    setPermissionMode: async (mode) => { await req().setPermissionMode(toSdkPermissionMode(mode)); },
    applyPermissionRules: async (rules) => {
      await req().applyFlagSettings({ permissions: rules });
    },
    stopTask: async (taskId) => { await req().stopTask(taskId); },
    supportedCommands: async () => {
      const list = await req().supportedCommands();
      return list.map((c) => ({
        name: c.name,
        description: c.description,
        source: 'sdk-core' as const,
      }));
    },
    supportedModels: async () => {
      const list = await req().supportedModels();
      return list.map((m) => ({
        id: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
    },
    supportedAgents: async () => {
      const list = await req().supportedAgents();
      return list.map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model,
      }));
    },
    mcpServerStatus: async () => {
      const list = await req().mcpServerStatus();
      // SDK exposes: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'.
      // Pass through unchanged so callers can distinguish intentional disablement
      // from broken servers.
      return list.map((s) => ({
        name: s.name,
        status: s.status,
        error: s.error,
      }));
    },
    getContextUsage: async () => {
      const u = await req().getContextUsage();
      // Categories shape: `{ name, tokens, color }[]` — fold into named buckets.
      const byName = new Map<string, number>();
      for (const c of u.categories ?? []) byName.set(c.name, c.tokens);
      const pick = (k: string): number => byName.get(k) ?? 0;
      return {
        totalTokens: u.totalTokens ?? 0,
        systemPromptTokens: pick('System prompt') || pick('system_prompt'),
        messagesTokens: pick('Messages') || pick('messages'),
        toolsTokens: pick('Tools') || pick('tools'),
        mcpToolsTokens: pick('MCP tools') || pick('mcp_tools'),
        memoryFilesTokens: pick('Memory files') || pick('memory_files'),
        maxTokens: u.maxTokens ?? 200000,
      };
    },
    accountInfo: async () => {
      const a = await req().accountInfo();
      return {
        email: a.email,
        organization: a.organization,
        subscription: a.subscriptionType,
      };
    },
    forkSession: async (title) => {
      const sid = getSdkSessionId();
      if (!sid) throw new UnsupportedByRuntimeError('claude', 'forkSession before session ready');
      const result = await sdkForkSession(sid, title ? { title } : undefined);
      return { sdkSessionId: result.sessionId };
    },
    renameSession: async (sid, title) => {
      await sdkRenameSession(sid, title);
    },
    rewindFiles: async (userMessageId, opts) => {
      const result = await req().rewindFiles(userMessageId, opts);
      // SDK's RewindFilesResult: filesChanged is string[] (paths touched);
      // insertions/deletions are line counts, not file counts.
      return {
        canRewind: result.canRewind,
        error: result.error,
        filesChanged: result.filesChanged?.length ?? 0,
        insertions: result.insertions ?? 0,
        deletions: result.deletions ?? 0,
      };
    },
    reloadPlugins: async () => { await req().reloadPlugins(); },
    setMcpServers: async (servers) => {
      const result = await req().setMcpServers(servers as unknown as Record<string, SdkMcpServerConfig>);
      const failed = Object.entries(result.errors ?? {}).map(([name, error]) => ({ name, error }));
      return {
        added: result.added ?? [],
        removed: result.removed ?? [],
        failed,
      };
    },
    reconnectMcpServer: async (name) => { await req().reconnectMcpServer(name); },
    toggleMcpServer: async (name, enabled) => { await req().toggleMcpServer(name, enabled); },
  };
}

function toSdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  switch (mode) {
    case 'yolo':
    case 'safe-yolo':
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'acceptEdits':
    case 'plan':
    case 'default':
    case 'dontAsk':
      return mode;
    default:
      return 'default';
  }
}
