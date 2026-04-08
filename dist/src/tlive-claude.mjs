// src/cli/claude.ts
import { stdin, stdout, exit } from "node:process";
import { networkInterfaces, homedir as homedir5 } from "node:os";
import { connect } from "node:net";
import { join as join6 } from "node:path";

// src/loop.ts
import { EventEmitter as EventEmitter5 } from "node:events";

// src/core/sessionManager.ts
import { EventEmitter as EventEmitter3 } from "node:events";
import { randomUUID } from "node:crypto";

// src/core/ptyManager.ts
import { spawn as ptySpawn } from "node-pty";
import { EventEmitter } from "node:events";
var PTYManager = class extends EventEmitter {
  pty = null;
  _exitCode = null;
  get isRunning() {
    return this.pty !== null;
  }
  get exitCode() {
    return this._exitCode;
  }
  get pid() {
    return this.pty?.pid;
  }
  spawn(opts) {
    if (this.pty) throw new Error("PTY already running");
    const env = {
      ...process.env,
      ...opts.env,
      TERM: process.env.TERM ?? "xterm-256color"
    };
    this.pty = ptySpawn(opts.command, opts.args, {
      name: "xterm-256color",
      cols: opts.cols ?? process.stdout.columns ?? 80,
      rows: opts.rows ?? process.stdout.rows ?? 24,
      cwd: opts.cwd,
      env
    });
    this.pty.onData((data) => this.emit("data", data));
    this.pty.onExit(({ exitCode, signal }) => {
      this._exitCode = exitCode;
      this.pty = null;
      this.emit("exit", exitCode, signal);
    });
  }
  write(data) {
    this.pty?.write(data);
  }
  resize(cols, rows) {
    this.pty?.resize(cols, rows);
  }
  async kill(signal = "SIGTERM") {
    if (!this.pty) return;
    this.pty.kill(signal);
    if (this.pty) {
      await new Promise((resolve) => {
        const onExit = () => {
          this.removeListener("exit", onExit);
          resolve();
        };
        this.on("exit", onExit);
      });
    }
  }
};

// src/core/sessionScanner.ts
import { watch, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { EventEmitter as EventEmitter2 } from "node:events";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename } from "node:path";
var SessionScanner = class extends EventEmitter2 {
  watcher = null;
  pollTimer = null;
  seenUUIDs = /* @__PURE__ */ new Set();
  lastSize = 0;
  pendingToolUse = /* @__PURE__ */ new Map();
  jsonlPath;
  opts;
  constructor(opts) {
    super();
    this.opts = {
      proactiveNotifyDelay: 6e4,
      proactiveQuestionDelay: 5e3,
      pollingInterval: 3e3,
      ...opts
    };
    this.jsonlPath = this.resolveJsonlPath(opts.workdir, opts.sessionId);
  }
  get filePath() {
    return this.jsonlPath;
  }
  resolveJsonlPath(workdir, sessionId) {
    const projectHash = createHash("sha256").update(workdir).digest("hex").slice(0, 16);
    return join(homedir(), ".claude", "projects", projectHash, `${sessionId}.jsonl`);
  }
  start() {
    try {
      const dir = join(this.jsonlPath, "..");
      this.watcher = watch(dir, (eventType, filename) => {
        if (filename === basename(this.jsonlPath)) this.readNewLines();
      });
    } catch {
    }
    this.pollTimer = setInterval(() => this.readNewLines(), this.opts.pollingInterval);
  }
  stop() {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const pending of this.pendingToolUse.values()) {
      clearTimeout(pending.timerId);
    }
    this.pendingToolUse.clear();
  }
  readNewLines() {
    if (!existsSync(this.jsonlPath)) return;
    const stat = statSync(this.jsonlPath);
    if (stat.size <= this.lastSize) return;
    const buf = Buffer.alloc(stat.size - this.lastSize);
    const fd = openSync(this.jsonlPath, "r");
    readSync(fd, buf, 0, buf.length, this.lastSize);
    closeSync(fd);
    this.lastSize = stat.size;
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        this.processMessage(parsed);
      } catch {
      }
    }
  }
  processMessage(msg) {
    const uuid = msg.uuid;
    if (!uuid || this.seenUUIDs.has(uuid)) return;
    this.seenUUIDs.add(uuid);
    const type = msg.type;
    if (type === "system" || type === "summary") return;
    const event = { type, uuid, message: msg.message, raw: msg };
    this.emit("event", event);
    if (type === "assistant" && Array.isArray(msg.message)) {
      for (const block of msg.message) {
        if (block.type === "tool_use") this.trackToolUse(block);
      }
    }
    if (type === "result" || type === "user" && Array.isArray(msg.message)) {
      const blocks = Array.isArray(msg.message) ? msg.message : [];
      for (const block of blocks) {
        if (block.type === "tool_result") this.resolveToolUse(block.tool_use_id);
      }
    }
  }
  trackToolUse(block) {
    const toolUseId = block.id;
    const toolName = block.name;
    if (!toolUseId) return;
    const isQuestion = toolName === "AskUserQuestion";
    const delay = isQuestion ? this.opts.proactiveQuestionDelay : this.opts.proactiveNotifyDelay;
    const timerId = setTimeout(() => {
      const pending = this.pendingToolUse.get(toolUseId);
      if (pending) {
        this.pendingToolUse.delete(toolUseId);
        this.emit("permission_needed", pending.toolUse);
      }
    }, delay);
    this.pendingToolUse.set(toolUseId, {
      toolUse: { toolUseId, toolName, input: block.input, timestamp: Date.now() },
      timerId
    });
  }
  resolveToolUse(toolUseId) {
    const pending = this.pendingToolUse.get(toolUseId);
    if (pending) {
      clearTimeout(pending.timerId);
      this.pendingToolUse.delete(toolUseId);
      this.emit("permission_resolved", toolUseId);
    }
  }
};

// src/sdk/permissionHandler.ts
var BasePermissionHandler = class {
  pending = /* @__PURE__ */ new Map();
  alwaysAllow = /* @__PURE__ */ new Set();
  waitForApproval(id, toolName, input, opts) {
    return new Promise((resolve) => {
      let timerId;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        timerId = setTimeout(() => {
          this.pending.delete(id);
          resolve({ behavior: "deny", message: "Permission timeout" });
        }, opts.timeoutMs);
      }
      const entry = { id, toolName, input, resolve, timerId };
      this.pending.set(id, entry);
      opts?.signal?.addEventListener("abort", () => {
        this.pending.delete(id);
        if (timerId) clearTimeout(timerId);
        resolve({ behavior: "deny", message: "Aborted" });
      }, { once: true });
    });
  }
  resolve(id, decision, updatedInput) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    if (pending.timerId) clearTimeout(pending.timerId);
    this.pending.delete(id);
    if (decision === "allow_always") this.alwaysAllow.add(pending.toolName);
    pending.resolve({ behavior: decision === "deny" ? "deny" : "allow", updatedInput });
    return true;
  }
  cancelAll() {
    for (const [, entry] of this.pending) {
      if (entry.timerId) clearTimeout(entry.timerId);
      entry.resolve({ behavior: "deny", message: "Cancelled" });
    }
    this.pending.clear();
  }
  get pendingCount() {
    return this.pending.size;
  }
};
var INTERACTIVE_TOOLS = /* @__PURE__ */ new Set(["AskUserQuestion"]);
var ClaudePermissionHandler = class extends BasePermissionHandler {
  opts;
  requestCounter = 0;
  constructor(opts = {}) {
    super();
    this.opts = opts;
  }
  async handleToolCall(toolName, input, callOpts) {
    if (this.alwaysAllow.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const id = `perm-${++this.requestCounter}`;
    const isInteractive = INTERACTIVE_TOOLS.has(toolName);
    const timeoutMs = isInteractive ? 0 : this.opts.timeout ?? 55e3;
    this.opts.onPermissionRequest?.(id, toolName, input);
    return this.waitForApproval(id, toolName, input, { signal: callOpts?.signal, timeoutMs });
  }
};

// src/core/sessionManager.ts
var SessionManager = class extends EventEmitter3 {
  _state = "idle";
  sessionId;
  workdir;
  pty;
  scanner;
  adapter;
  config;
  permissionHandler = null;
  sdkAbortController = null;
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId ?? randomUUID();
    this.workdir = opts.workdir;
    this.adapter = opts.adapter;
    this.config = opts.config;
    this.pty = new PTYManager();
    this.scanner = new SessionScanner({
      sessionId: this.sessionId,
      workdir: this.workdir,
      proactiveNotifyDelay: opts.config.proactiveNotifyDelay,
      proactiveQuestionDelay: opts.config.proactiveQuestionDelay
    });
    this.setupListeners();
  }
  get state() {
    return this._state;
  }
  get info() {
    return { sessionId: this.sessionId, workdir: this.workdir, state: this._state, createdAt: Date.now() };
  }
  setState(state) {
    this._state = state;
    this.emit("stateChange", state, this.info);
  }
  setupListeners() {
    this.pty.on("data", (data) => this.emit("ptyData", data));
    this.pty.on("exit", () => {
      if (this._state === "pty_active") {
        this.setState("idle");
        this.emit("sessionComplete", this.info);
      }
    });
    this.scanner.on("event", (event) => this.emit("scannerEvent", event));
    this.scanner.on("permission_needed", (toolUse) => this.emit("permissionNeeded", toolUse));
    this.scanner.on("permission_resolved", (toolUseId) => this.emit("permissionResolved", toolUseId));
  }
  async startPTY() {
    if (this._state !== "idle") throw new Error(`Cannot start PTY from state: ${this._state}`);
    const executable = await this.adapter.resolveExecutable();
    const args = this.adapter.spawnArgs({ sessionId: this.sessionId, cwd: this.workdir });
    this.pty.spawn({ command: executable, args, cwd: this.workdir });
    this.scanner.start();
    this.setState("pty_active");
  }
  async handoffToSDK(opts) {
    if (this._state !== "pty_active") throw new Error(`Cannot handoff from state: ${this._state}`);
    await this.pty.kill();
    this.setState("sdk_active");
    this.sdkAbortController = new AbortController();
    this.permissionHandler = new ClaudePermissionHandler({
      timeout: this.config.permissionTimeout,
      onPermissionRequest: opts?.onPermissionRequest
    });
    try {
      const stream = this.adapter.startRemote({
        sessionId: this.sessionId,
        cwd: this.workdir,
        resume: true,
        permissionHandler: this.permissionHandler,
        signal: this.sdkAbortController.signal,
        onAskUserQuestion: opts?.onAskUserQuestion
      });
      for await (const msg of stream) {
        this.emit("sdkMessage", msg);
        if (msg.kind === "complete") break;
      }
    } catch (err) {
      if (err.name !== "AbortError") this.emit("error", err);
    }
    this.permissionHandler = null;
    this.sdkAbortController = null;
    if (this._state === "sdk_active") await this.restorePTY();
  }
  async restorePTY() {
    const executable = await this.adapter.resolveExecutable();
    const args = [...this.adapter.getResumeArgs(this.sessionId)];
    this.pty.spawn({ command: executable, args, cwd: this.workdir });
    this.setState("pty_active");
  }
  async takebackToTerminal() {
    if (this._state !== "sdk_active") return;
    this.sdkAbortController?.abort();
    this.permissionHandler?.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.restorePTY();
  }
  resolvePermission(id, decision) {
    return this.permissionHandler?.resolve(id, decision) ?? false;
  }
  writeToPTY(data) {
    this.pty.write(data);
  }
  resizePTY(cols, rows) {
    this.pty.resize(cols, rows);
  }
  async stop() {
    this.scanner.stop();
    this.sdkAbortController?.abort();
    this.permissionHandler?.cancelAll();
    if (this.pty.isRunning) await this.pty.kill();
    this.setState("idle");
  }
};

// src/core/projectRegistry.ts
import { readFileSync, writeFileSync, existsSync as existsSync2, mkdirSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var REGISTRY_PATH = join2(homedir2(), ".tlive", "projects.json");
var ProjectRegistry = class {
  projects = /* @__PURE__ */ new Map();
  constructor() {
    this.load();
  }
  load() {
    if (!existsSync2(REGISTRY_PATH)) return;
    try {
      const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
      if (Array.isArray(data)) {
        for (const entry of data) this.projects.set(entry.path, entry);
      }
    } catch {
    }
  }
  save() {
    const dir = join2(REGISTRY_PATH, "..");
    mkdirSync(dir, { recursive: true });
    const entries = [...this.projects.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2));
  }
  register(path, name) {
    const existing = this.projects.get(path);
    this.projects.set(path, {
      path,
      name: name ?? existing?.name ?? path.split("/").pop() ?? path,
      lastUsed: Date.now()
    });
    this.save();
  }
  touch(path) {
    const entry = this.projects.get(path);
    if (entry) {
      entry.lastUsed = Date.now();
      this.save();
    }
  }
  list() {
    return [...this.projects.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  }
  getRecent() {
    return this.list()[0];
  }
  resolve(query) {
    if (this.projects.has(query)) return this.projects.get(query);
    const lower = query.toLowerCase();
    return this.list().find((p) => p.name.toLowerCase() === lower);
  }
  remove(path) {
    const deleted = this.projects.delete(path);
    if (deleted) this.save();
    return deleted;
  }
};

// src/im/notificationHub.ts
import { EventEmitter as EventEmitter4 } from "node:events";
var NotificationHub = class extends EventEmitter4 {
  seen = /* @__PURE__ */ new Map();
  batch = [];
  batchTimer = null;
  batchDelay;
  TTL = 15 * 60 * 1e3;
  constructor(opts = {}) {
    super();
    this.batchDelay = opts.batchDelay ?? 250;
  }
  push(event) {
    if (this.seen.has(event.dedupeKey)) return;
    this.seen.set(event.dedupeKey, Date.now());
    if (event.severity === "critical" || event.requiresUserAction) {
      this.flush();
      this.emit("notify", [event]);
      return;
    }
    this.batch.push(event);
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), this.batchDelay);
    }
  }
  cancel(dedupeKey) {
    const idx = this.batch.findIndex((e) => e.dedupeKey === dedupeKey);
    if (idx !== -1) {
      this.batch.splice(idx, 1);
      return true;
    }
    return false;
  }
  flush() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.batch.length > 0) {
      this.emit("notify", [...this.batch]);
      this.batch = [];
    }
  }
  prune() {
    const now = Date.now();
    for (const [key, ts] of this.seen) {
      if (now - ts > this.TTL) this.seen.delete(key);
    }
  }
  reset() {
    this.seen.clear();
    this.batch = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }
};

// src/im/sessionRouter.ts
var SessionRouter = class {
  groupBindings = /* @__PURE__ */ new Map();
  privateBindings = /* @__PURE__ */ new Map();
  terminalNotifications = /* @__PURE__ */ new Map();
  workdirMemory = /* @__PURE__ */ new Map();
  bindGroup(chatId, sessionId, workdir) {
    this.groupBindings.set(chatId, { sessionId, workdir });
  }
  unbindGroup(chatId) {
    this.groupBindings.delete(chatId);
  }
  bindPrivate(chatId, sessionId, workdir) {
    this.privateBindings.set(chatId, { sessionId, workdir });
    this.workdirMemory.set(chatId, workdir);
  }
  unbindPrivate(chatId) {
    this.privateBindings.delete(chatId);
  }
  registerTerminalNotification(messageId, sessionId, workdir) {
    this.terminalNotifications.set(messageId, { messageId, sessionId, workdir });
  }
  getLastWorkdir(chatId) {
    return this.workdirMemory.get(chatId);
  }
  route(opts) {
    const { chatId, isGroup, callbackSessionId, replyToMessageId } = opts;
    if (callbackSessionId) return { kind: "sdk_session", sessionId: callbackSessionId };
    if (isGroup) {
      const binding = this.groupBindings.get(chatId);
      if (binding) return { kind: "sdk_session", sessionId: binding.sessionId, workdir: binding.workdir };
      return { kind: "new_session" };
    }
    if (replyToMessageId) {
      const notif = this.terminalNotifications.get(replyToMessageId);
      if (notif) return { kind: "terminal_takeover", sessionId: notif.sessionId, workdir: notif.workdir };
    }
    const priv = this.privateBindings.get(chatId);
    if (priv) return { kind: "sdk_session", sessionId: priv.sessionId, workdir: priv.workdir };
    return { kind: "new_session", workdir: this.workdirMemory.get(chatId) };
  }
  pruneTerminalNotifications() {
    if (this.terminalNotifications.size > 1e3) {
      const entries = [...this.terminalNotifications.entries()];
      for (const [key] of entries.slice(0, entries.length - 500)) {
        this.terminalNotifications.delete(key);
      }
    }
  }
};

// src/sdk/messageNormalizer.ts
function normalizeSessionLine(line, provider, sessionId) {
  const messages = [];
  const content = line.message;
  if (line.type === "assistant" && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        messages.push({ kind: "text", provider, sessionId, text: block.text });
      } else if (block.type === "tool_use") {
        messages.push({ kind: "tool_use", provider, sessionId, toolName: block.name, toolInput: block.input });
      }
    }
  }
  if (line.type === "user" && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "tool_result") {
        messages.push({
          kind: "tool_result",
          provider,
          sessionId,
          parentToolUseId: block.tool_use_id,
          text: typeof block.content === "string" ? block.content : JSON.stringify(block.content)
        });
      }
    }
  }
  return messages;
}
function formatForIM(msg) {
  switch (msg.kind) {
    case "text":
      return msg.text ?? "";
    case "tool_use":
      return `\u{1F527} ${msg.toolName}`;
    case "tool_result":
      return `\u2705 Result`;
    case "permission_request":
      return `\u26A0\uFE0F Permission: ${msg.toolName}
${summarizeInput(msg.toolInput)}`;
    case "error":
      return `\u274C ${msg.text}`;
    case "complete":
      return "\u2705 Session complete";
    case "status":
      return `\u2139\uFE0F ${msg.text}`;
    default:
      return "";
  }
}
function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const obj = input;
  if (obj.command) return `\`${truncate(String(obj.command), 200)}\``;
  if (obj.file_path) return `\`${obj.file_path}\``;
  if (obj.path) return `\`${obj.path}\``;
  if (obj.pattern) return `\`${obj.pattern}\``;
  return truncate(JSON.stringify(input), 200);
}
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

// src/loop.ts
var TLiveLoop = class extends EventEmitter5 {
  session;
  registry;
  notifications;
  router;
  config;
  imSend;
  imChatId;
  constructor(opts) {
    super();
    this.config = opts.config;
    this.registry = new ProjectRegistry();
    this.notifications = new NotificationHub({ batchDelay: opts.config.messageBatchDelay });
    this.router = new SessionRouter();
    this.session = new SessionManager({
      sessionId: opts.sessionId,
      workdir: opts.workdir,
      adapter: opts.adapter,
      config: opts.config
    });
    this.registry.register(opts.workdir);
    this.wireEvents();
  }
  get sessionInfo() {
    return this.session.info;
  }
  get sessionState() {
    return this.session.state;
  }
  setIMTarget(chatId, sendFn) {
    this.imChatId = chatId;
    this.imSend = sendFn;
  }
  wireEvents() {
    this.session.on("ptyData", (data) => this.emit("ptyData", data));
    this.session.on("scannerEvent", (event) => {
      const normalized = normalizeSessionLine(
        { uuid: event.uuid, type: event.type, message: event.message },
        "claude",
        this.session.info.sessionId
      );
      for (const msg of normalized) {
        const text = formatForIM(msg);
        if (!text) continue;
        this.notifications.push({
          kind: "activity",
          dedupeKey: `activity:${event.uuid}:${msg.kind}`,
          severity: "info",
          requiresUserAction: false,
          sessionId: this.session.info.sessionId,
          title: `\u{1F4AC} ${this.shortWorkdir()}`,
          body: text
        });
      }
    });
    this.session.on("permissionNeeded", (toolUse) => {
      const isQuestion = toolUse.toolName === "AskUserQuestion";
      this.notifications.push({
        kind: isQuestion ? "question" : "permission_required",
        dedupeKey: `perm:${toolUse.toolUseId}`,
        severity: "warning",
        requiresUserAction: true,
        sessionId: this.session.info.sessionId,
        title: isQuestion ? `\u2753 Claude asks \xB7 ${this.shortWorkdir()}` : `\u26A0\uFE0F Claude waiting \xB7 ${this.shortWorkdir()}`,
        body: formatForIM({
          kind: "permission_request",
          provider: "claude",
          sessionId: this.session.info.sessionId,
          toolName: toolUse.toolName,
          toolInput: toolUse.input
        }),
        buttons: isQuestion ? void 0 : [
          { label: "Allow", callbackData: `perm:allow:${toolUse.toolUseId}` },
          { label: "Deny", callbackData: `perm:deny:${toolUse.toolUseId}`, style: "danger" },
          { label: "Takeover", callbackData: `perm:takeover:${toolUse.toolUseId}` }
        ]
      });
    });
    this.session.on("permissionResolved", (toolUseId) => {
      this.notifications.cancel(`perm:${toolUseId}`);
    });
    this.session.on("sdkMessage", (msg) => this.emit("sdkMessage", msg));
    this.notifications.on("notify", async (events) => {
      if (!this.imSend || !this.imChatId) return;
      for (const event of events) {
        const text = event.body ? `${event.title}
${event.body}` : event.title;
        const messageId = await this.imSend(this.imChatId, text, event.buttons);
        if (messageId && event.kind === "permission_required") {
          this.router.registerTerminalNotification(messageId, this.session.info.sessionId, this.session.info.workdir);
        }
      }
    });
    this.session.on("sessionComplete", () => {
      this.notifications.push({
        kind: "task_complete",
        dedupeKey: `complete:${this.session.info.sessionId}`,
        severity: "info",
        requiresUserAction: false,
        sessionId: this.session.info.sessionId,
        title: `\u2705 Session complete \xB7 ${this.shortWorkdir()}`
      });
    });
  }
  async start() {
    await this.session.startPTY();
  }
  async handleIMAction(action, toolUseId) {
    if (action === "takeover") {
      await this.session.handoffToSDK({
        onPermissionRequest: (id, toolName, input) => {
          this.notifications.push({
            kind: "permission_required",
            dedupeKey: `perm:${id}`,
            severity: "warning",
            requiresUserAction: true,
            sessionId: this.session.info.sessionId,
            title: `\u26A0\uFE0F ${toolName}`,
            body: JSON.stringify(input).slice(0, 200),
            buttons: [
              { label: "Allow", callbackData: `perm:allow:${id}` },
              { label: "Deny", callbackData: `perm:deny:${id}`, style: "danger" }
            ]
          });
        }
      });
    } else if (action === "allow" || action === "deny") {
      if (this.session.state === "sdk_active") {
        this.session.resolvePermission(toolUseId, action);
      } else {
        await this.session.handoffToSDK({
          onPermissionRequest: (id) => {
            setTimeout(() => this.session.resolvePermission(id, action), 100);
          }
        });
      }
    }
  }
  async handleTerminalInput(data) {
    if (this.session.state === "sdk_active") {
      await this.session.takebackToTerminal();
    } else {
      this.session.writeToPTY(data);
    }
  }
  async stop() {
    this.notifications.reset();
    await this.session.stop();
  }
  shortWorkdir() {
    return this.session.info.workdir.split("/").pop() ?? this.session.info.workdir;
  }
};

// src/sdk/claudeAdapter.ts
import { execSync } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
var ClaudeAdapter = class {
  name = "claude";
  executablePath = null;
  async resolveExecutable() {
    if (this.executablePath) return this.executablePath;
    if (process.env.CTI_CLAUDE_CODE_EXECUTABLE) {
      this.executablePath = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
      return this.executablePath;
    }
    try {
      this.executablePath = execSync("which claude", {
        encoding: "utf-8"
      }).trim();
    } catch {
      this.executablePath = "claude";
    }
    return this.executablePath;
  }
  getSessionIdArgs(sessionId) {
    return ["--session-id", sessionId];
  }
  getResumeArgs(sessionId) {
    return ["--resume", "--session-id", sessionId];
  }
  spawnArgs(opts) {
    const args = [...this.getSessionIdArgs(opts.sessionId)];
    if (opts.args) args.push(...opts.args);
    return args;
  }
  async *startRemote(_opts) {
    throw new Error(
      "startRemote requires Claude Agent SDK \u2014 wire in integration task"
    );
  }
  getSessionDir(workdir) {
    const projectHash = createHash2("sha256").update(workdir).digest("hex").slice(0, 16);
    return join3(homedir3(), ".claude", "projects", projectHash);
  }
};

// src/core/webTerminal.ts
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFileSync as readFileSync2, existsSync as existsSync3 } from "node:fs";
import { join as join4, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript"
};
var WebTerminal = class {
  httpServer;
  wss;
  clients = /* @__PURE__ */ new Set();
  token;
  webDir;
  onInput;
  onResize;
  constructor(opts) {
    this.token = opts.token;
    const __dirname = dirname(fileURLToPath(import.meta.url));
    this.webDir = opts.webDir ?? join4(__dirname, "../../web");
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);
      if (this.token && url.pathname === "/") {
        if (url.searchParams.get("token") !== this.token) {
          res.writeHead(403);
          res.end("Unauthorized");
          return;
        }
      }
      let filePath;
      if (url.pathname === "/" || url.pathname === "/index.html") {
        filePath = join4(this.webDir, "terminal.html");
      } else {
        const safe = url.pathname.replace(/\.\./g, "");
        filePath = join4(this.webDir, safe);
      }
      if (existsSync3(filePath)) {
        const ext = extname(filePath);
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
        res.end(readFileSync2(filePath));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => {
      if (this.token) {
        const url = new URL(req.url ?? "", `http://localhost:${opts.port}`);
        if (url.searchParams.get("token") !== this.token) {
          ws.close(4001, "Unauthorized");
          return;
        }
      }
      this.clients.add(ws);
      ws.on("message", (raw) => {
        const data = raw.toString();
        try {
          const msg = JSON.parse(data);
          if (msg.type === "resize" && msg.cols && msg.rows) {
            this.onResize?.(msg.cols, msg.rows);
            return;
          }
        } catch {
        }
        this.onInput?.(data);
      });
      ws.on("close", () => this.clients.delete(ws));
    });
  }
  setInputHandler(handler) {
    this.onInput = handler;
  }
  setResizeHandler(handler) {
    this.onResize = handler;
  }
  broadcast(data) {
    const buf = Buffer.from(data);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(buf);
    }
  }
  sendControl(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
  startOnPort(port) {
    return new Promise((resolve) => {
      this.httpServer.listen(port, () => resolve());
    });
  }
  get address() {
    const addr = this.httpServer.address();
    if (typeof addr === "object" && addr) return addr;
    return null;
  }
  stop() {
    this.sendControl({ type: "exit", code: 0 });
    for (const ws of this.clients) ws.close();
    this.wss.close();
    this.httpServer.close();
  }
};

// src/config.ts
import { readFileSync as readFileSync3, existsSync as existsSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";
var DEFAULTS = {
  port: 8849,
  token: "",
  defaultProvider: "claude",
  permissionTimeout: 55e3,
  webEnabled: false,
  messageBatchDelay: 250,
  proactiveNotifyDelay: 6e4,
  proactiveQuestionDelay: 5e3
};
function loadConfig(envPath) {
  const configPath = envPath ?? join5(homedir4(), ".tlive", "config.env");
  const env = { ...process.env };
  if (existsSync4(configPath)) {
    const lines = readFileSync3(configPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!(key in env)) env[key] = val;
    }
  }
  return {
    port: parseInt(env.TL_PORT ?? "") || DEFAULTS.port,
    token: env.TL_TOKEN ?? DEFAULTS.token,
    defaultProvider: env.TL_DEFAULT_PROVIDER ?? DEFAULTS.defaultProvider,
    permissionTimeout: parseInt(env.TL_PERMISSION_TIMEOUT ?? "") || DEFAULTS.permissionTimeout,
    webEnabled: env.TL_WEB_ENABLED === "true",
    messageBatchDelay: parseInt(env.TL_MESSAGE_BATCH_DELAY ?? "") || DEFAULTS.messageBatchDelay,
    proactiveNotifyDelay: parseInt(env.TL_PROACTIVE_NOTIFY_DELAY ?? "") || DEFAULTS.proactiveNotifyDelay,
    proactiveQuestionDelay: parseInt(env.TL_PROACTIVE_QUESTION_DELAY ?? "") || DEFAULTS.proactiveQuestionDelay,
    telegram: env.TL_TELEGRAM_TOKEN ? { token: env.TL_TELEGRAM_TOKEN, chatId: env.TL_TELEGRAM_CHAT_ID ?? "" } : void 0,
    discord: env.TL_DISCORD_TOKEN ? { token: env.TL_DISCORD_TOKEN, channelId: env.TL_DISCORD_CHANNEL_ID ?? "" } : void 0,
    feishu: env.TL_FEISHU_APP_ID ? { appId: env.TL_FEISHU_APP_ID, appSecret: env.TL_FEISHU_APP_SECRET ?? "" } : void 0,
    proxy: env.TL_PROXY || env.HTTPS_PROXY || void 0
  };
}

// src/cli/claude.ts
function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
var IPC_PATH = join6(homedir5(), ".tlive", "ipc.sock");
function connectIPC() {
  return new Promise((resolve) => {
    const socket = connect(IPC_PATH, () => resolve(socket));
    socket.on("error", () => resolve(null));
  });
}
async function claudeCommand(opts = {}) {
  const config = loadConfig();
  const adapter = new ClaudeAdapter();
  const workdir = opts.workdir ?? process.cwd();
  const loop = new TLiveLoop({ workdir, adapter, config, sessionId: opts.sessionId });
  const webPort = config.port;
  const webToken = config.token || loop.sessionInfo.sessionId.slice(0, 16);
  const web = new WebTerminal({ port: webPort, token: webToken });
  loop.on("ptyData", (data) => {
    stdout.write(data);
    web.broadcast(data);
  });
  web.setInputHandler((data) => loop.handleTerminalInput(data));
  await web.startOnPort(webPort);
  const localIP = getLocalIP();
  const url = `http://${localIP}:${webPort}/?token=${webToken}`;
  const ipc = await connectIPC();
  if (ipc) {
    loop.setIMTarget("ipc", async (_chatId, text, buttons) => {
      const msg = JSON.stringify({
        type: "notification",
        payload: {
          text,
          buttons,
          sessionId: loop.sessionInfo.sessionId,
          workdir
        }
      }) + "\n";
      ipc.write(msg);
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(void 0), 3e3);
        const onData = (raw) => {
          const lines = raw.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const resp = JSON.parse(line);
              if (resp.type === "message_sent") {
                clearTimeout(timeout);
                ipc.removeListener("data", onData);
                resolve(resp.payload.messageId);
                return;
              }
              if (resp.type === "permission_action") {
                const { action, toolUseId } = resp.payload;
                loop.handleIMAction(action, toolUseId);
              }
            } catch {
            }
          }
        };
        ipc.on("data", onData);
      });
    });
    let ipcBuffer = "";
    ipc.on("data", (raw) => {
      ipcBuffer += raw.toString();
      const lines = ipcBuffer.split("\n");
      ipcBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "permission_action") {
            const { action, toolUseId } = msg.payload;
            loop.handleIMAction(action, toolUseId);
          }
        } catch {
        }
      }
    });
    console.error(`  IM:       \x1B[32mconnected\x1B[0m (bridge IPC)`);
  } else {
    console.error(`  IM:       \x1B[33mnot connected\x1B[0m (bridge not running)`);
  }
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
  }
  stdin.on("data", (data) => {
    loop.handleTerminalInput(data.toString());
  });
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    ipc?.destroy();
    web.stop();
    await loop.stop();
    if (stdin.isTTY) stdin.setRawMode(false);
    exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  const info = loop.sessionInfo;
  console.error("");
  console.error(`  \x1B[36m\u26A1 TLive v1.0\x1B[0m`);
  console.error(`  Session:  ${info.sessionId.slice(0, 8)}...`);
  console.error(`  Workdir:  ${workdir}`);
  console.error(`  Terminal: \x1B[4m${url}\x1B[0m`);
  try {
    await loop.start();
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (loop.sessionState === "idle") {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  } finally {
    await cleanup();
  }
}
export {
  claudeCommand
};
