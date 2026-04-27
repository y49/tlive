// src/daemon/bootstrap.ts
//
// Unified daemon bootstrap — wires every subsystem from T1-T8 into a
// cohesive process and returns a `DaemonHandle` whose `shutdown()` tears
// down in the spec §13.1 order.
//
// Subsystems wired here:
//   - loadConfig + v0.x migration (src/config/*)
//   - WorkspaceManager (persist: ~/.tlive/workspaces.json) hydrated from
//     config.workspaces
//   - SessionPersistence at ~/.tlive/sessions/
//   - Permission + Ask + Elicitation brokers (with per-workspace PolicyStore
//     factory injection)
//   - AttachmentStore at ~/.tlive/attachments/
//   - CostRollupStore at ~/.tlive/cost/rollups.jsonl
//   - WarmRuntimePool
//   - SessionManager with RuntimeFactory (claude | codex)
//   - McpRegistry + Federation (lazy downstream clients)
//   - CronEngine driven by McpToolDeps
//   - PlatformAdapters for every channel configured (Telegram / Discord /
//     Feishu) — passed to SessionFrontend + CallbackRouter
//   - SessionFrontend (started after adapters + broker subscriptions)
//   - CommandParser registration (registerAllCommands) + CallbackRouter
//     inbound dispatch glued to every adapter's onInbound
//   - Reliability guardrails: auto-resume on startup, idle-stop, stale
//     permission recovery (exposed to CallbackRouter via adapters), api-
//     throttle retry
//   - IPC server at ~/.tlive/daemon.sock
//   - Optional health HTTP endpoint on cfg.daemon.healthPort
//
// Shutdown order (reentrancy guard in lifecycle.ts):
//   cron → adapters → stopAll sessions → warm-pool drain → IPC close →
//   health close → federation closeAll → persistence flush.
//
// This file is the single place production wiring lives; tests can either
// call it directly (with a fake config + in-memory persistence) or exercise
// individual guardrail modules in isolation.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

import { loadConfig, type LoadConfigResult } from '../config/loader.js';
import type { TliveConfigV1 } from '../config/schema.js';

import { WorkspaceManager } from '../workspace/manager.js';
import { autoBindFromConfig } from '../workspace/auto-bind.js';
import { SessionManager } from '../session/manager.js';
import { SessionPersistence } from '../session/persistence.js';
import { WarmRuntimePool } from '../session/warm-pool.js';
import type { LocalSession } from '../session/local-session.js';

import { PermissionBroker } from '../permission/broker.js';
import { AskUserQuestionBroker } from '../permission/ask-broker.js';
import { ElicitationBroker } from '../permission/elicitation-broker.js';
import { PolicyStore } from '../permission/policy-store.js';
import { AttachmentStore } from '../attachment/store.js';

import { CostRollupStore } from '../cost/rollups.js';

import { McpRegistry } from '../mcp/registry.js';
import { CronEngine } from '../mcp/self/cron.js';
import { Federation } from '../mcp/self/federation.js';
import { InMemorySignalBus } from '../mcp/self/signals.js';
import type { McpToolDeps, IMNotifier } from '../mcp/self/deps.js';

import { SessionFrontend } from '../im/frontend.js';
import { registerAllCommands } from '../im/commands/index.js';
import { dispatch as dispatchCommand, type CommandContext } from '../im/command-parser.js';
import { CallbackRouter } from '../im/callback-router.js';
import { registerAllBotCommands } from '../im/bot-commands-registrar.js';

import { TelegramAdapter } from '../platform/telegram/adapter.js';
import { DiscordAdapter } from '../platform/discord/adapter.js';
import { FeishuAdapter } from '../platform/feishu/adapter.js';
import type { PlatformAdapter, InboundEvent } from '../platform/types.js';
import type { ChannelType } from '../workspace/bindings.js';

import type { AgentProvider, AgentRuntime } from '../runtime/types.js';
import { ClaudeSdkRuntime } from '../runtime/claude/runtime.js';
import { CodexAppServerRuntime } from '../runtime/codex/runtime.js';

import { startIpcServer, type IpcServerHandle } from '../ipc/server.js';
import { buildIpcDispatcher } from '../ipc/dispatcher.js';

import { createLifecycle, type ShutdownStep, type LifecycleHandle } from './lifecycle.js';
import { startHealthServer, type HealthServerHandle } from './health.js';
import { autoResumeOnStartup, type AutoResumeReport } from './auto-resume.js';
import { startIdleStop, type IdleStopHandle } from './idle-stop.js';
import { startApiThrottleRetry, bindManagerForRetry } from './api-throttle-retry.js';

import { createLogger, type Logger } from '../util/logger.js';

// ---- Public surface --------------------------------------------------------

export interface BootstrapOptions {
  /** Override `~/.tlive`. */
  home?: string;
  /** Override `$TLIVE_CONFIG_PATH`. */
  configPath?: string;
  /** Custom logger — tests pass a spy. */
  logger?: Logger;
  /** Platform-adapter factory override (tests inject mocks). */
  adapterFactory?: AdapterFactory;
  /** When true, skip the heavy subsystems that block tests (adapters, IPC,
   *  health HTTP). Useful for unit tests that only exercise wiring. */
  startAdapters?: boolean;
  startIpc?: boolean;
  startHealth?: boolean;
  /** Runtime factory override. Default: Claude or Codex runtime based on provider. */
  runtimeFactory?: (provider: AgentProvider) => AgentRuntime;
}

export interface DaemonHandle {
  readonly lifecycle: LifecycleHandle;
  readonly sessions: SessionManager;
  readonly workspaces: WorkspaceManager;
  readonly frontend: SessionFrontend;
  readonly permissionBroker: PermissionBroker;
  readonly askBroker: AskUserQuestionBroker;
  readonly elicitationBroker: ElicitationBroker;
  readonly mcpRegistry: McpRegistry;
  readonly attachments: AttachmentStore;
  readonly rollups: CostRollupStore;
  readonly warmPool: WarmRuntimePool;
  readonly adapters: Partial<Record<ChannelType, PlatformAdapter>>;
  readonly callbackRouter: CallbackRouter;
  readonly ipc: IpcServerHandle | null;
  readonly health: HealthServerHandle | null;
  readonly cron: CronEngine;
  readonly federation: Federation;
  readonly config: TliveConfigV1;
  readonly configPath: string;
  readonly autoResumeReport: AutoResumeReport;
  readonly idleStop: IdleStopHandle;
  shutdown(): Promise<void>;
}

export type AdapterFactory = (
  channelType: ChannelType,
  cfg: TliveConfigV1,
  logger: Logger,
) => PlatformAdapter | null;

/** Default factory — constructs real grammy/discord.js/lark adapters. */
export const defaultAdapterFactory: AdapterFactory = (channelType, cfg, logger) => {
  const ch = cfg.channels ?? {};
  try {
    if (channelType === 'telegram' && ch.telegram) {
      return new TelegramAdapter({ token: ch.telegram.token });
    }
    if (channelType === 'discord' && ch.discord) {
      return new DiscordAdapter({ token: ch.discord.token });
    }
    if (channelType === 'feishu' && ch.feishu) {
      return new FeishuAdapter({
        appId: ch.feishu.appId,
        appSecret: ch.feishu.appSecret,
        lark: ch.feishu.lark === true,
        logger,
      });
    }
  } catch (err) {
    logger.warn('adapter construction failed', { channelType, reason: (err as Error).message });
  }
  return null;
};

// ---- Bootstrap -------------------------------------------------------------

export async function bootstrapDaemon(opts: BootstrapOptions = {}): Promise<DaemonHandle> {
  const home = opts.home ?? join(homedir(), '.tlive');
  const logger = opts.logger ?? createLogger();

  // --- Config -------------------------------------------------------------
  const loaded: LoadConfigResult = await loadConfig({ home, configPath: opts.configPath });
  const cfg = loaded.config;
  if (loaded.migration?.migrated) {
    logger.info('config migrated v0.x -> v1', {
      dropped: loaded.migration.dropped,
      warnings: loaded.migration.warnings,
    });
  }
  for (const w of loaded.warnings) logger.warn('config warning', { path: w.path, message: w.message });

  // --- Workspace manager -------------------------------------------------
  const workspacesPath = join(home, 'workspaces.json');
  const workspaces = new WorkspaceManager({ persistPath: workspacesPath });
  await workspaces.load();
  // Hydrate any workspace present in config that is not yet persisted
  // (single source of truth is workspaces.json; config.workspaces seeds
  // a fresh install).
  for (const w of cfg.workspaces) {
    if (w.id && workspaces.get(w.id)) continue;
    if (workspaces.findByWorkdir(w.workdir)) continue;
    const created = workspaces.create({
      name: w.name,
      workdir: w.workdir,
      gitRemote: w.gitRemote,
      defaults: w.defaults,
      budget: w.budget,
      defaultRole: w.defaultRole,
    });
    if (w.roles) {
      for (const [uid, role] of Object.entries(w.roles)) workspaces.setRole(created.id, uid, role);
    }
  }
  // Claim admin from config-declared adminUserId. Idempotent — only fires
  // when no admin role is currently assigned on the workspace.
  for (const w of cfg.workspaces) {
    const target = (w.id ? workspaces.get(w.id) : undefined)
      ?? workspaces.findByWorkdir(w.workdir);
    if (!target || !w.adminUserId) continue;
    try {
      const claimed = workspaces.claimAdmin(target.id, w.adminUserId);
      if (claimed) logger.info('claimed admin from config', {
        workspaceId: target.id, workspaceName: target.name, userId: w.adminUserId,
      });
    } catch (err) {
      logger.warn('claimAdmin failed', { workspaceName: w.name, reason: (err as Error).message });
    }
  }

  // Auto-bind chats declared in config.channels.<platform>.chatId.
  autoBindFromConfig(workspaces, cfg, logger);

  await workspaces.save().catch(() => undefined);

  // --- Persistence + cost rollups ---------------------------------------
  const persistence = new SessionPersistence(join(home, 'sessions'));
  await persistence.init();
  const rollups = new CostRollupStore(join(home, 'cost', 'rollups.jsonl'));

  // --- Brokers + policy store factory -----------------------------------
  const policyStoreFor = makePolicyStoreFactory(home);
  const broker = new PermissionBroker({ policyStoreFor });
  const askBroker = new AskUserQuestionBroker();
  const elicitBroker = new ElicitationBroker();

  // --- Attachments -------------------------------------------------------
  const attachments = new AttachmentStore({ rootDir: join(home, 'attachments') });
  await attachments.init();

  // --- Warm pool + runtime factory --------------------------------------
  const warmPool = new WarmRuntimePool();
  const runtimeFactory = opts.runtimeFactory ?? ((provider: AgentProvider): AgentRuntime => {
    if (provider === 'codex') return new CodexAppServerRuntime();
    return new ClaudeSdkRuntime();
  });

  // --- SessionManager ----------------------------------------------------
  const sessions = new SessionManager({
    persistence,
    broker,
    askBroker,
    elicitationBroker: elicitBroker,
    runtimeFactory,
    attachmentStore: attachments,
    warmPool,
    rollupStore: rollups,
  });

  // Bind SessionManager to LocalSession instances so the api-throttle retry
  // helper can call resumeLocal() from a session event closure.
  sessions.subscribe((ev) => {
    if (ev.kind === 'created' || ev.kind === 'resumed') {
      bindManagerForRetry(ev.session, sessions);
    }
  });

  // --- MCP registry + federation + cron ---------------------------------
  const mcpRegistry = new McpRegistry({ file: join(home, 'mcp-registry.json') });
  await mcpRegistry.load();
  // Seed registry from config.mcpRegistry if present.
  if (cfg.mcpRegistry) {
    for (const [name, entry] of Object.entries(cfg.mcpRegistry)) {
      if (mcpRegistry.get(name)) continue;
      await mcpRegistry.add({
        name,
        config: entry.config as never,
        enabled: entry.enabled ?? true,
        autoSpawn: entry.autoSpawn,
        workspaceIds: entry.workspaceIds,
      }).catch(() => undefined);
    }
  }

  const federation = new Federation(mcpRegistry, async () => {
    // Lazy downstream factory — real stdio/SSE/HTTP spawn lives in T5's
    // bundled/federation paths. For daemon bootstrap we keep the stub
    // behaviour (no-op factory) so federation.callTool returns errors
    // gracefully rather than crashing boot.
    throw new Error('federation factory not wired in daemon bootstrap');
  });

  const signals = new InMemorySignalBus();
  const notifier: IMNotifier = {
    notify(sessionId, text) {
      // Route through the SessionFrontend when possible; fall back to stderr.
      // Adapter-direct sends happen via the frontend's renderers elsewhere.
      logger.info('im-notify', { sessionId, text });
    },
  };

  const mcpDeps: McpToolDeps = {
    sessions,
    workspaces,
    permissionBroker: broker,
    askBroker,
    elicitationBroker: elicitBroker,
    attachments,
    policyStoreFor,
    rollups,
    signals,
    notifier,
    user: () => ({ id: 'daemon', displayName: 'tlive' }),
    dataDir: home,
  };

  const cron = new CronEngine(mcpDeps, { file: join(home, 'schedules.json') });
  await cron.load();
  // Seed schedules from config if present.
  if (cfg.schedules) {
    for (const s of cfg.schedules) {
      if (cron.list().some((t) => t.id === s.id)) continue;
      await cron.add({
        cron: s.cron ?? null,
        at: s.at ?? null,
        daily: s.daily ?? null,
        weekly: s.weekly ?? null,
        workspaceId: s.workspaceId,
        prompt: s.prompt,
        provider: s.provider ?? 'claude',
      } as never).catch(() => undefined);
    }
  }
  cron.start();

  // --- Platform adapters -------------------------------------------------
  const adapters: Partial<Record<ChannelType, PlatformAdapter>> = {};
  const adapterFactory = opts.adapterFactory ?? defaultAdapterFactory;
  if (opts.startAdapters !== false) {
    for (const ct of (['telegram', 'discord', 'feishu'] as const)) {
      const a = adapterFactory(ct, cfg, logger);
      if (!a) continue;
      try {
        await a.start();
        adapters[ct] = a;
      } catch (err) {
        logger.warn('adapter start failed', { channelType: ct, reason: (err as Error).message });
      }
    }
    // Register top-16 bot commands on each capable adapter.
    await registerAllBotCommands(adapters).catch(() => undefined);
  }

  // --- IM frontend -------------------------------------------------------
  const frontend = new SessionFrontend({
    sessionManager: sessions,
    workspaceManager: workspaces,
    permissionBroker: broker,
    askBroker,
    elicitationBroker: elicitBroker,
    adapters,
  });
  frontend.start();

  // --- Command parser + Callback router ---------------------------------
  registerAllCommands();
  const callbackRouter = new CallbackRouter({
    sessionManager: sessions,
    permissionBroker: broker,
    askBroker,
    elicitationBroker: elicitBroker,
    adapters,
    policyStoreFor,
  });

  // --- Inbound → command/callback dispatch ------------------------------
  const inboundUnsubs: Array<() => void> = [];
  for (const [ctRaw, adapter] of Object.entries(adapters)) {
    if (!adapter) continue;
    const ct = ctRaw as ChannelType;
    const off = adapter.onInbound((ev) => {
      void handleInbound(ev, {
        channelType: ct,
        adapter,
        sessions,
        workspaces,
        broker,
        askBroker,
        elicitBroker,
        mcpRegistry,
        rollups,
        persistence,
        attachments,
        policyStoreFor,
        callbackRouter,
        logger,
      }).catch((err) => logger.error('inbound handler failed', { reason: (err as Error).message }));
    });
    inboundUnsubs.push(off);
  }

  // --- Reliability guardrails -------------------------------------------
  const idleStop = startIdleStop({
    sessions,
    persistence,
    idleHours: cfg.daemon?.idleHours ?? 24,
    logger,
  });
  const throttleRetry = startApiThrottleRetry({ sessions, logger });

  // Auto-resume on startup (§13.2). Returns a report the handle exposes.
  const autoResumeReport = await autoResumeOnStartup({
    sessions,
    workspaces,
    persistence,
    cutoffHours: cfg.daemon?.resumeCutoffHours ?? 24,
    logger,
  });

  // --- PID file for scripts/cli.js compatibility ------------------------
  await writePidFile(home).catch(() => undefined);

  // --- IPC server --------------------------------------------------------
  // Default transport: unix-domain socket on POSIX, Windows named pipe
  // on win32. `cfg.daemon.socketPath` overrides on either platform.
  const defaultIpcPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\tlive-daemon'
    : join(home, 'daemon.sock');
  const ipcPath = cfg.daemon?.socketPath ?? defaultIpcPath;
  const dispatcher = buildIpcDispatcher({
    sessions,
    workspaces,
    persistence,
    rollups,
    startedAt: Date.now(),
    warmPool,
    adapters,
    requestDaemonShutdown: () => { void lifecycle.shutdown(); },
  });
  const ipc = opts.startIpc === false ? null : await startIpcServer({
    path: ipcPath,
    handler: dispatcher,
  });

  // --- Optional health HTTP endpoint ------------------------------------
  const health = (opts.startHealth !== false && cfg.daemon?.healthPort !== undefined)
    ? await startHealthServer({
        port: cfg.daemon.healthPort,
        sessions,
        warmPool,
      })
    : null;

  // --- Lifecycle --------------------------------------------------------
  const steps: ShutdownStep[] = [
    { name: 'cron', async run() { cron.stop(); } },
    { name: 'throttle-retry', async run() { throttleRetry.stop(); } },
    { name: 'idle-stop', async run() { idleStop.stop(); } },
    { name: 'inbound-unsubs', async run() { for (const u of inboundUnsubs) { try { u(); } catch { /* isolate */ } } } },
    { name: 'adapters', async run() {
      for (const a of Object.values(adapters)) {
        if (!a) continue;
        try { await a.stop(); } catch { /* isolate */ }
      }
    } },
    { name: 'frontend', async run() { await frontend.stop(); } },
    { name: 'sessions', async run() { await sessions.stopAll(); } },
    { name: 'warm-pool', async run() { await warmPool.drain(); } },
    { name: 'ipc', async run() { if (ipc) await ipc.close(); } },
    { name: 'health', async run() { if (health) await health.close(); } },
    { name: 'federation', async run() { await federation.closeAll(); } },
    { name: 'workspaces-persist', async run() { await workspaces.save().catch(() => undefined); } },
    { name: 'pid-file', async run() { await removePidFile(home).catch(() => undefined); } },
  ];
  const lifecycle = createLifecycle(steps, logger);

  logger.info('daemon bootstrap complete', {
    workspaces: workspaces.list().length,
    adapters: Object.keys(adapters),
    autoResumed: autoResumeReport.resumed.length,
    ipcPath,
  });

  return {
    lifecycle,
    sessions,
    workspaces,
    frontend,
    permissionBroker: broker,
    askBroker,
    elicitationBroker: elicitBroker,
    mcpRegistry,
    attachments,
    rollups,
    warmPool,
    adapters,
    callbackRouter,
    ipc,
    health,
    cron,
    federation,
    config: cfg,
    configPath: loaded.path,
    autoResumeReport,
    idleStop,
    async shutdown() { await lifecycle.shutdown(); },
  };
}

// ---- Helpers ---------------------------------------------------------------

function makePolicyStoreFactory(home: string): (workspaceId: string) => PolicyStore {
  const cache = new Map<string, PolicyStore>();
  return (workspaceId: string) => {
    const cached = cache.get(workspaceId);
    if (cached) return cached;
    const file = join(home, 'workspaces', workspaceId, 'policies.json');
    const store = new PolicyStore(workspaceId, { file });
    cache.set(workspaceId, store);
    // Kick off load asynchronously; callers that need eager data should
    // await store.load() themselves.
    void store.load().catch(() => undefined);
    return store;
  };
}

async function writePidFile(home: string): Promise<void> {
  const file = join(home, 'daemon.pid');
  await writeFile(file, String(process.pid), 'utf8').catch(() => undefined);
}

async function removePidFile(home: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  const file = join(home, 'daemon.pid');
  await unlink(file).catch(() => undefined);
}

// ---- Inbound dispatch ------------------------------------------------------

interface InboundDeps {
  channelType: ChannelType;
  adapter: PlatformAdapter;
  sessions: SessionManager;
  workspaces: WorkspaceManager;
  broker: PermissionBroker;
  askBroker: AskUserQuestionBroker;
  elicitBroker: ElicitationBroker;
  mcpRegistry: McpRegistry;
  rollups: CostRollupStore;
  persistence: SessionPersistence;
  attachments: AttachmentStore;
  policyStoreFor: (workspaceId: string) => PolicyStore;
  callbackRouter: CallbackRouter;
  logger: Logger;
}

async function handleInbound(ev: InboundEvent, deps: InboundDeps): Promise<void> {
  // Callback (inline button click) → CallbackRouter.
  if (ev.kind === 'callback' && ev.callbackData) {
    const outcome = await deps.callbackRouter.route({
      data: ev.callbackData,
      userId: ev.userId,
      chatId: ev.chatId,
      messageId: ev.messageId,
      channelType: ev.channelType,
    });
    deps.logger.debug('callback routed', { kind: outcome.kind, user: ev.userId });
    return;
  }

  // Text starting with '/' → slash command.
  const text = ev.text?.trim() ?? '';
  if (!text) return;
  if (!text.startsWith('/')) {
    // Plain-text: route to the workspace's lazyResumeOrCreate. We need a
    // workspace first — look up by chat binding.
    const ws = deps.workspaces.findByChat(ev.channelType, ev.chatId);
    if (!ws) {
      await deps.adapter.send({
        chatId: ev.chatId,
        threadId: ev.threadId,
        text: [
          "This chat isn't bound to any workspace yet.",
          '',
          "If you're the admin:",
          '  • Send /bind to attach me to your workspace',
          '  • Multiple workspaces? Use /bind <name>',
          '',
          "Not sure if you're the admin?",
          '  • Send /whoami to see what I know about you',
          '  • Or pre-configure ~/.tlive/config.json with',
          '    workspaces[].adminUserId and channels.<platform>.chatId,',
          "    then restart the daemon — I'll auto-bind on next start.",
        ].join('\n'),
      }).catch(() => undefined);
      return;
    }
    try {
      await deps.workspaces.lazyResumeOrCreate(ws.id, text, 'im', {
        isLive: (id) => {
          const s = deps.sessions.get(id);
          if (s === undefined) return false;
          if (s.kind !== 'local') return false;
          return (s as LocalSession).getStatus() === 'active';
        },
        resume: async (id) => deps.sessions.resumeLocal(id),
        sendInput: async (id, t, src) => {
          const found = deps.sessions.get(id);
          if (!found) throw new Error(`session ${id} not live`);
          // LocalSession has sendInput; RemoteSession does not
          const local = found as unknown as { sendInput?: (t: string, s: 'im' | 'cli') => Promise<void> };
          if (local.sendInput) await local.sendInput(t, src);
        },
        createLocal: async (opts) => deps.sessions.createLocal({
          workspaceId: opts.workspaceId,
          workspaceName: ws.name,
          provider: opts.provider,
          workdir: opts.workdir,
          initialPrompt: opts.initialPrompt,
          source: opts.source,
        }),
      });
    } catch (err) {
      await deps.adapter.send({
        chatId: ev.chatId,
        threadId: ev.threadId,
        text: `error: ${(err as Error).message}`,
      }).catch(() => undefined);
    }
    return;
  }

  // Slash command — build a CommandContext tied to this adapter for reply.
  const wsForRole = deps.workspaces.findByChat(ev.channelType, ev.chatId);
  const userRole = wsForRole ? deps.workspaces.getRole(wsForRole.id, ev.userId) : 'observer';

  const ctx: CommandContext = {
    inbound: ev,
    userId: ev.userId,
    sessionManager: deps.sessions,
    workspaceManager: deps.workspaces,
    permissionBroker: deps.broker,
    askBroker: deps.askBroker,
    elicitationBroker: deps.elicitBroker,
    policyStoreFor: deps.policyStoreFor,
    rollupStore: deps.rollups,
    mcpRegistry: deps.mcpRegistry,
    persistence: deps.persistence,
    attachments: deps.attachments,
    reply: async (text, opts) => {
      await deps.adapter.send({
        chatId: ev.chatId,
        threadId: ev.threadId,
        text,
        replyMarkup: opts?.replyMarkup,
      });
    },
  };

  await dispatchCommand(ctx, text, userRole);
}
