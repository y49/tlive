// src/cli/claude.ts
import { stdin, stdout, exit } from "node:process";
import { networkInterfaces } from "node:os";

// src/loop.ts
import { EventEmitter as EventEmitter6 } from "node:events";

// src/core/sessionManager.ts
import { EventEmitter as EventEmitter4 } from "node:events";
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
      await new Promise((resolve4) => {
        const onExit = () => {
          this.removeListener("exit", onExit);
          resolve4();
        };
        this.on("exit", onExit);
      });
    }
  }
};

// src/core/sessionScanner.ts
import { watch, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { EventEmitter as EventEmitter2 } from "node:events";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
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
    const projectDir = resolve(workdir).replace(/[^a-zA-Z0-9-]/g, "-");
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    return join(claudeConfigDir, "projects", projectDir, `${sessionId}.jsonl`);
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
  /**
   * Extract content blocks from a message.
   * Claude .jsonl format: { message: { role: "assistant", content: [...] } }
   * We need the content array.
   */
  getContentBlocks(message) {
    if (Array.isArray(message)) return message;
    if (message && typeof message === "object") {
      const content = message.content;
      if (Array.isArray(content)) return content;
    }
    return [];
  }
  processMessage(msg) {
    const uuid = msg.uuid;
    if (!uuid || this.seenUUIDs.has(uuid)) return;
    this.seenUUIDs.add(uuid);
    const type = msg.type;
    if (type === "system" || type === "summary") return;
    if (type === "permission-mode" || type === "file-history-snapshot" || type === "change" || type === "queue-operation" || type === "attachment") return;
    const event = { type, uuid, message: msg.message, raw: msg };
    this.emit("event", event);
    const blocks = this.getContentBlocks(msg.message);
    if (type === "assistant") {
      for (const block of blocks) {
        if (block.type === "tool_use") this.trackToolUse(block);
      }
      const messageObj = msg.message;
      if (messageObj && typeof messageObj === "object") {
        const usage = messageObj.usage;
        if (usage && typeof usage === "object") this.emit("usage", usage);
        const model = messageObj.model;
        if (typeof model === "string") this.emit("model", model);
      }
    }
    if (type === "result" || type === "user") {
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
    const toolUseEvent = { toolUseId, toolName, input: block.input, timestamp: Date.now() };
    if (isQuestion) {
      const inputObj = block.input;
      toolUseEvent.questionText = inputObj?.question ?? "";
      const options = inputObj?.options;
      if (Array.isArray(options)) {
        toolUseEvent.questionOptions = options.map((o) => o.label ?? o.description ?? String(o));
      }
    }
    const timerId = setTimeout(() => {
      const pending = this.pendingToolUse.get(toolUseId);
      if (pending) {
        this.pendingToolUse.delete(toolUseId);
        this.emit("permission_needed", pending.toolUse);
      }
    }, delay);
    this.pendingToolUse.set(toolUseId, {
      toolUse: toolUseEvent,
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

// src/sdk/permissionPolicies.ts
var SAFE_TOOLS = /* @__PURE__ */ new Set(["Read", "Glob", "Grep", "TodoRead", "WebSearch"]);
var EDIT_TOOLS = /* @__PURE__ */ new Set([...SAFE_TOOLS, "Edit", "Write", "NotebookEdit"]);
var DANGEROUS_PATTERNS = [/rm\s+-rf/, /git\s+push.*--force/, /DROP\s+TABLE/i];
function isAllowed(mode, toolName, input) {
  switch (mode) {
    case "yolo":
      return true;
    case "auto-approve": {
      if (toolName === "Bash") {
        const cmd = input?.command ?? "";
        return !DANGEROUS_PATTERNS.some((p) => p.test(cmd));
      }
      return true;
    }
    case "accept-edits":
      return EDIT_TOOLS.has(toolName);
    case "default":
      return SAFE_TOOLS.has(toolName);
  }
}

// src/sdk/permissionHandler.ts
var BasePermissionHandler = class {
  pending = /* @__PURE__ */ new Map();
  alwaysAllow = /* @__PURE__ */ new Set();
  waitForApproval(id, toolName, input, opts) {
    return new Promise((resolve4) => {
      let timerId;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        timerId = setTimeout(() => {
          this.pending.delete(id);
          resolve4({ behavior: "deny", message: "Permission timeout" });
        }, opts.timeoutMs);
      }
      const entry = { id, toolName, input, resolve: resolve4, timerId };
      this.pending.set(id, entry);
      opts?.signal?.addEventListener("abort", () => {
        this.pending.delete(id);
        if (timerId) clearTimeout(timerId);
        resolve4({ behavior: "deny", message: "Aborted" });
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
  mode = "default";
  constructor(opts = {}) {
    super();
    this.opts = opts;
  }
  setMode(mode) {
    this.mode = mode;
  }
  async handleToolCall(toolName, input, callOpts) {
    if (isAllowed(this.mode, toolName, input)) {
      return { behavior: "allow", updatedInput: input };
    }
    if (this.alwaysAllow.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    const id = `perm-${++this.requestCounter}`;
    const isInteractive = INTERACTIVE_TOOLS.has(toolName);
    const timeoutMs = isInteractive ? 0 : this.opts.timeout ?? 0;
    this.opts.onPermissionRequest?.(id, toolName, input);
    return this.waitForApproval(id, toolName, input, { signal: callOpts?.signal, timeoutMs });
  }
};

// src/core/thinkingTracker.ts
import { EventEmitter as EventEmitter3 } from "node:events";
var ThinkingTracker = class extends EventEmitter3 {
  activeToolCalls = /* @__PURE__ */ new Set();
  _isThinking = false;
  debounceTimer = null;
  DEBOUNCE_MS = 500;
  get isThinking() {
    return this._isThinking;
  }
  trackToolUse(toolUseId) {
    this.activeToolCalls.add(toolUseId);
    this.updateState(true);
  }
  trackToolResult(toolUseId) {
    this.activeToolCalls.delete(toolUseId);
    if (this.activeToolCalls.size === 0) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (this.activeToolCalls.size === 0) this.updateState(false);
      }, this.DEBOUNCE_MS);
    }
  }
  trackAssistantMessage() {
    this.activeToolCalls.clear();
    this.updateState(false);
  }
  updateState(thinking) {
    if (thinking === this._isThinking) return;
    this._isThinking = thinking;
    this.emit("change", thinking);
  }
  reset() {
    this.activeToolCalls.clear();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this._isThinking = false;
  }
};

// src/core/sessionManager.ts
var SessionManager = class extends EventEmitter4 {
  _state = "idle";
  sessionId;
  workdir;
  pty;
  scanner;
  adapter;
  config;
  permissionHandler = null;
  sdkAbortController = null;
  thinkingTracker;
  _createdAt = Date.now();
  _lastActivityAt = Date.now();
  _messageCount = 0;
  constructor(opts) {
    super();
    this.sessionId = opts.sessionId ?? randomUUID();
    this.workdir = opts.workdir;
    this.adapter = opts.adapter;
    this.config = opts.config;
    this.pty = new PTYManager();
    this.thinkingTracker = new ThinkingTracker();
    this.thinkingTracker.on("change", (thinking) => this.emit("thinking", thinking));
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
    return {
      sessionId: this.sessionId,
      workdir: this.workdir,
      state: this._state,
      createdAt: this._createdAt,
      lastActivityAt: this._lastActivityAt,
      messageCount: this._messageCount
    };
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
    this.scanner.on("event", (event) => {
      this._lastActivityAt = Date.now();
      this._messageCount++;
      this.emit("scannerEvent", event);
      const blocks = this.getContentBlocks(event.message);
      if (event.type === "assistant") {
        for (const block of blocks) {
          if (block.type === "tool_use" && block.id) {
            this.thinkingTracker.trackToolUse(block.id);
          } else if (block.type === "text") {
            this.thinkingTracker.trackAssistantMessage();
          }
        }
      }
      if (event.type === "user") {
        for (const block of blocks) {
          if (block.type === "tool_result" && block.tool_use_id) {
            this.thinkingTracker.trackToolResult(block.tool_use_id);
          }
        }
      }
    });
    this.scanner.on("permission_needed", (toolUse) => this.emit("permissionNeeded", toolUse));
    this.scanner.on("permission_resolved", (toolUseId) => this.emit("permissionResolved", toolUseId));
    this.scanner.on("usage", (usage) => this.emit("usage", usage));
    this.scanner.on("model", (model) => this.emit("model", model));
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
    await new Promise((resolve4) => setTimeout(resolve4, 100));
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
  /**
   * Extract content blocks from a message.
   * Claude .jsonl format: { message: { role: "assistant", content: [...] } }
   */
  getContentBlocks(message) {
    if (Array.isArray(message)) return message;
    if (message && typeof message === "object") {
      const content = message.content;
      if (Array.isArray(content)) return content;
    }
    return [];
  }
  async stop() {
    this.thinkingTracker.reset();
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
import { EventEmitter as EventEmitter5 } from "node:events";

// src/im/notificationRules.ts
var RULES = {
  permission_request: { alwaysPush: true, aggregate: false, maxTextLength: 500 },
  ask_user_question: { alwaysPush: true, aggregate: false, maxTextLength: 500 },
  error: { alwaysPush: true, aggregate: false, maxTextLength: 300 },
  session_complete: { alwaysPush: true, aggregate: false, maxTextLength: 100 },
  todo_update: { alwaysPush: true, aggregate: false, maxTextLength: 500 },
  thinking: { alwaysPush: true, aggregate: false, maxTextLength: 50 },
  activity_text: { alwaysPush: true, aggregate: false, maxTextLength: 300 },
  activity_tool: { alwaysPush: false, aggregate: true, maxTextLength: 500 }
};
function shouldPush(kind, isUserActive) {
  const rule = RULES[kind];
  return rule.alwaysPush || !isUserActive;
}
function shouldAggregate(kind) {
  return RULES[kind].aggregate;
}

// src/im/notificationHub.ts
var NotificationHub = class extends EventEmitter5 {
  seen = /* @__PURE__ */ new Map();
  batch = [];
  batchTimer = null;
  batchDelay;
  isUserActive;
  TTL = 15 * 60 * 1e3;
  constructor(opts = {}) {
    super();
    this.batchDelay = opts.batchDelay ?? 250;
    this.isUserActive = opts.isUserActive;
  }
  push(event) {
    if (this.seen.has(event.dedupeKey)) return;
    this.seen.set(event.dedupeKey, Date.now());
    const active = this.isUserActive?.() ?? false;
    if (!shouldPush(event.kind, active)) return;
    if (!shouldAggregate(event.kind)) {
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

// src/im/icons.ts
var LABEL = {
  permission: "\u26A0 Permission",
  question: "\u2753 Question",
  done: "\u2713 Done",
  error: "\u2717 Error",
  thinking: "... Thinking",
  tasks: "\u2630 Tasks",
  terminal: "Terminal",
  tool: "\u25B8",
  // prefix for tool call lines
  replyHint: "\u21A9 Reply to this message to interact"
};

// src/sdk/messageNormalizer.ts
function getContentBlocks(message) {
  if (Array.isArray(message)) return message;
  if (message && typeof message === "object") {
    const content = message.content;
    if (Array.isArray(content)) return content;
  }
  return [];
}
function normalizeSessionLine(line, provider, sessionId) {
  const messages = [];
  const blocks = getContentBlocks(line.message);
  if (line.type === "assistant") {
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        messages.push({ kind: "text", provider, sessionId, text: block.text });
      } else if (block.type === "tool_use") {
        messages.push({ kind: "tool_use", provider, sessionId, toolName: block.name, toolInput: block.input });
      }
    }
  }
  if (line.type === "user") {
    for (const block of blocks) {
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
var imFormatters = {
  text: (msg) => msg.text ?? "",
  tool_use: (msg) => `${LABEL.tool} ${msg.toolName}${formatToolArgs(msg.toolName, msg.toolInput)}`,
  tool_result: () => "",
  permission_request: (msg) => `${LABEL.permission}: ${msg.toolName}
${formatToolArgs(msg.toolName, msg.toolInput)}`,
  error: (msg) => `${LABEL.error}: ${msg.text}`,
  complete: () => `${LABEL.done}`,
  status: (msg) => msg.text ?? ""
};
function formatForIM(msg) {
  const formatter = imFormatters[msg.kind];
  return formatter ? formatter(msg) : "";
}
var MAX_ARG_LEN = 150;
var toolArgFormatters = {
  Bash: (a) => a.command ? `
\`${truncate(String(a.command), MAX_ARG_LEN)}\`` : "",
  Read: (a) => a.file_path ? `
${truncate(String(a.file_path), MAX_ARG_LEN)}` : "",
  Edit: (a) => formatFilePath(a),
  Write: (a) => formatFilePath(a),
  Grep: (a) => a.pattern ? ` \`${truncate(String(a.pattern), 80)}\`` : "",
  Glob: (a) => a.pattern ? ` \`${truncate(String(a.pattern), 80)}\`` : "",
  WebFetch: (a) => a.url ? `
${truncate(String(a.url), MAX_ARG_LEN)}` : "",
  Agent: (a) => a.prompt ? `
${truncate(String(a.prompt), MAX_ARG_LEN)}` : "",
  AskUserQuestion: (a) => a.question ? `
${truncate(String(a.question), MAX_ARG_LEN)}` : ""
};
function defaultToolArgFormatter(args) {
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) return `
${truncate(v, MAX_ARG_LEN)}`;
  }
  return "";
}
function formatToolArgs(toolName, input) {
  if (!input || typeof input !== "object" || !toolName) return "";
  const args = input;
  const formatter = toolArgFormatters[toolName] ?? defaultToolArgFormatter;
  return formatter(args);
}
function formatFilePath(args) {
  const file = args.file_path ?? args.path ?? "";
  return file ? `
${truncate(String(file), MAX_ARG_LEN)}` : "";
}
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
function extractTodos(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput;
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;
  return todos.map((t) => ({
    content: t.content ?? t.subject ?? String(t),
    status: t.status ?? "pending"
  }));
}
function formatTodos(todos) {
  const marks = {
    completed: "[x]",
    in_progress: "[-]",
    pending: "[ ]"
  };
  return todos.map((t) => `${marks[t.status] ?? "[ ]"} ${t.content}`).join("\n");
}

// src/core/costTracker.ts
var PRICING = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
};
var CostTracker = class {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  model = "default";
  setModel(model) {
    this.model = model;
  }
  addUsage(usage) {
    this.inputTokens += usage.input_tokens || 0;
    this.outputTokens += usage.output_tokens || 0;
    this.cacheReadTokens += usage.cache_read_input_tokens || 0;
    this.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
  }
  get summary() {
    const p = PRICING[this.model] ?? PRICING.default;
    const cost = this.inputTokens / 1e6 * p.input + this.outputTokens / 1e6 * p.output + this.cacheReadTokens / 1e6 * p.cacheRead + this.cacheWriteTokens / 1e6 * p.cacheWrite;
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      estimatedCostUsd: Math.round(cost * 1e3) / 1e3
    };
  }
  formatSummary() {
    const s = this.summary;
    const fmt = (n) => n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
    return `Tokens: ${fmt(s.inputTokens)} in / ${fmt(s.outputTokens)} out` + (s.cacheReadTokens ? ` / ${fmt(s.cacheReadTokens)} cached` : "") + `
Cost: ~$${s.estimatedCostUsd.toFixed(2)}`;
  }
  reset() {
    this.inputTokens = this.outputTokens = this.cacheReadTokens = this.cacheWriteTokens = 0;
  }
};

// src/loop.ts
var MAX_IM_TEXT_LEN = 300;
var TLiveLoop = class extends EventEmitter6 {
  session;
  registry;
  notifications;
  router;
  config;
  costTracker;
  imSend;
  imChatId;
  lastTerminalInputAt = Date.now();
  constructor(opts) {
    super();
    this.config = opts.config;
    this.costTracker = new CostTracker();
    this.registry = new ProjectRegistry();
    this.notifications = new NotificationHub({
      batchDelay: opts.config.messageBatchDelay,
      isUserActive: () => this.isUserActive()
    });
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
  isUserActive() {
    return Date.now() - this.lastTerminalInputAt < this.config.activeThreshold;
  }
  // ---------------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------------
  wireEvents() {
    this.session.on("ptyData", (data) => this.emit("ptyData", data));
    this.session.on("scannerEvent", (event) => this.handleScannerEvent(event));
    this.session.on("permissionNeeded", (toolUse) => this.handlePermissionNeeded(toolUse));
    this.session.on("permissionResolved", (id) => {
      this.notifications.cancel(`perm:${id}`);
      this.notifications.cancel(`askq:${id}`);
    });
    this.session.on("sdkMessage", (msg) => this.emit("sdkMessage", msg));
    this.session.on("thinking", (thinking) => {
      if (thinking) {
        this.notifications.push({
          kind: "thinking",
          dedupeKey: "thinking:on",
          sessionId: this.session.info.sessionId,
          title: `${LABEL.thinking} \xB7 ${this.sessionTag()}`
        });
      }
    });
    this.session.on("usage", (usage) => this.costTracker.addUsage(usage));
    this.session.on("model", (model) => this.costTracker.setModel(model));
    this.session.on("sessionComplete", () => this.handleSessionComplete());
    this.notifications.on("notify", (events) => this.dispatchToIM(events));
  }
  // ---------------------------------------------------------------------------
  // Scanner activity → IM sync
  // ---------------------------------------------------------------------------
  handleScannerEvent(event) {
    const raw = event.raw;
    if (raw.isMeta) return;
    const normalized = normalizeSessionLine(
      { uuid: event.uuid, type: event.type, message: event.message },
      "claude",
      this.session.info.sessionId
    );
    for (const msg of normalized) {
      if (msg.kind !== "tool_use") {
        const text2 = formatForIM(msg);
        if (!text2) continue;
        const body = text2.length > MAX_IM_TEXT_LEN ? text2.slice(0, MAX_IM_TEXT_LEN) + "..." : text2;
        this.notifications.push({
          kind: "activity_text",
          dedupeKey: `activity:${event.uuid}:${msg.kind}`,
          sessionId: this.session.info.sessionId,
          title: `${LABEL.terminal} \xB7 ${this.sessionTag()}`,
          body: body + `

${LABEL.replyHint}`
        });
        continue;
      }
      if (msg.toolName === "AskUserQuestion") {
        const input = msg.toolInput;
        const questionText = input?.question ?? "Question from Claude";
        const options = Array.isArray(input?.options) ? input.options.map((o) => o.label ?? o.description ?? "?") : [];
        const toolUseId = `scanq:${event.uuid}`;
        const buttons = [];
        for (let i = 0; i < options.length; i++) {
          buttons.push({ label: options[i], callbackData: `askq:${toolUseId}:${i}` });
        }
        buttons.push({ label: "Skip", callbackData: `askq:${toolUseId}:skip`, style: "danger" });
        this.notifications.push({
          kind: "ask_user_question",
          dedupeKey: `askq:${event.uuid}`,
          sessionId: this.session.info.sessionId,
          title: `${LABEL.question} \xB7 ${this.sessionTag()}`,
          body: questionText,
          buttons
        });
        continue;
      }
      if (msg.toolName === "TodoWrite") {
        const todos = extractTodos(msg.toolInput);
        if (todos) {
          this.notifications.push({
            kind: "todo_update",
            dedupeKey: `todo:${event.uuid}`,
            sessionId: this.session.info.sessionId,
            title: `${LABEL.tasks} \xB7 ${this.sessionTag()}`,
            body: formatTodos(todos)
          });
          continue;
        }
      }
      const text = formatForIM(msg);
      if (!text) continue;
      this.notifications.push({
        kind: "activity_tool",
        dedupeKey: `activity:${event.uuid}:tool`,
        sessionId: this.session.info.sessionId,
        title: `${LABEL.terminal} \xB7 ${this.sessionTag()}`,
        body: text
      });
    }
  }
  // ---------------------------------------------------------------------------
  // Permission detection → IM alert
  // ---------------------------------------------------------------------------
  handlePermissionNeeded(toolUse) {
    if (toolUse.toolName === "AskUserQuestion") {
      const buttons = [];
      if (toolUse.questionOptions) {
        for (let i = 0; i < toolUse.questionOptions.length; i++) {
          buttons.push({
            label: toolUse.questionOptions[i],
            callbackData: `askq:${toolUse.toolUseId}:${i}`
          });
        }
      }
      buttons.push({
        label: "Skip",
        callbackData: `askq:${toolUse.toolUseId}:skip`,
        style: "danger"
      });
      this.notifications.push({
        kind: "ask_user_question",
        dedupeKey: `askq:${toolUse.toolUseId}`,
        sessionId: this.session.info.sessionId,
        title: `${LABEL.question} \xB7 ${this.sessionTag()}`,
        body: toolUse.questionText ?? "Question from Claude",
        buttons
      });
      return;
    }
    this.notifications.push({
      kind: "permission_request",
      dedupeKey: `perm:${toolUse.toolUseId}`,
      sessionId: this.session.info.sessionId,
      title: `${LABEL.permission} \xB7 ${this.sessionTag()}`,
      body: formatForIM({
        kind: "permission_request",
        provider: "claude",
        sessionId: this.session.info.sessionId,
        toolName: toolUse.toolName,
        toolInput: toolUse.input
      }),
      buttons: [
        { label: "Allow", callbackData: `perm:allow:${toolUse.toolUseId}` },
        { label: "Deny", callbackData: `perm:deny:${toolUse.toolUseId}`, style: "danger" },
        { label: "Takeover", callbackData: `perm:takeover:${toolUse.toolUseId}` }
      ]
    });
  }
  handleSessionComplete() {
    this.notifications.push({
      kind: "session_complete",
      dedupeKey: `complete:${this.session.info.sessionId}`,
      sessionId: this.session.info.sessionId,
      title: `${LABEL.done} \xB7 ${this.sessionTag()}`,
      body: this.costTracker.formatSummary()
    });
  }
  // ---------------------------------------------------------------------------
  // Notification dispatch → IM
  // ---------------------------------------------------------------------------
  async dispatchToIM(events) {
    if (!this.imSend || !this.imChatId) return;
    for (const event of events) {
      const text = event.body ? `${event.title}
${event.body}` : event.title;
      const messageId = await this.imSend(this.imChatId, text, event.buttons);
      if (messageId && (event.kind === "permission_request" || event.kind === "ask_user_question")) {
        this.router.registerTerminalNotification(
          messageId,
          this.session.info.sessionId,
          this.session.info.workdir
        );
      }
    }
  }
  // ---------------------------------------------------------------------------
  // IM action handlers — strategy map
  // ---------------------------------------------------------------------------
  actionHandlers = {
    takeover: (toolUseId) => this.handleTakeover(toolUseId),
    allow: (toolUseId) => this.handlePermissionDecision(toolUseId, "allow"),
    deny: (toolUseId) => this.handlePermissionDecision(toolUseId, "deny")
  };
  async handleIMAction(action, toolUseId) {
    const handler = this.actionHandlers[action];
    if (handler) await handler(toolUseId);
  }
  async handleTakeover(_toolUseId) {
    await this.session.handoffToSDK({
      onPermissionRequest: (id, toolName, input) => {
        this.notifications.push({
          kind: "permission_request",
          dedupeKey: `perm:${id}`,
          sessionId: this.session.info.sessionId,
          title: `${LABEL.permission}: ${toolName}`,
          body: formatForIM({
            kind: "permission_request",
            provider: "claude",
            sessionId: this.session.info.sessionId,
            toolName,
            toolInput: input
          }),
          buttons: [
            { label: "Allow", callbackData: `perm:allow:${id}` },
            { label: "Deny", callbackData: `perm:deny:${id}`, style: "danger" }
          ]
        });
      }
    });
  }
  async handlePermissionDecision(toolUseId, decision) {
    if (this.session.state === "sdk_active") {
      this.session.resolvePermission(toolUseId, decision);
    } else {
      await this.session.handoffToSDK({
        onPermissionRequest: (id) => {
          setTimeout(() => this.session.resolvePermission(id, decision), 100);
        }
      });
    }
  }
  // ---------------------------------------------------------------------------
  // Terminal input
  // ---------------------------------------------------------------------------
  async handleTerminalInput(data) {
    this.lastTerminalInputAt = Date.now();
    if (this.session.state === "sdk_active") {
      await this.session.takebackToTerminal();
    } else {
      this.session.writeToPTY(data);
    }
  }
  async start() {
    await this.session.startPTY();
  }
  async stop() {
    this.notifications.reset();
    await this.session.stop();
  }
  /** Project name for IM display (last non-empty path segment). */
  projectName() {
    const parts = this.session.info.workdir.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : "unknown";
  }
  /** Short session tag: project · #session-prefix */
  sessionTag() {
    return `${this.projectName()} \xB7 #${this.session.info.sessionId.slice(0, 6)}`;
  }
};

// src/sdk/claudeAdapter.ts
import { execSync } from "node:child_process";
import { homedir as homedir3 } from "node:os";
import { join as join3, resolve as resolve2 } from "node:path";
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
    const projectDir = resolve2(workdir).replace(/[^a-zA-Z0-9-]/g, "-");
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join3(homedir3(), ".claude");
    return join3(claudeConfigDir, "projects", projectDir);
  }
};

// src/ipc.ts
import { createServer, connect } from "node:net";
import { homedir as homedir4 } from "node:os";
import { join as join4 } from "node:path";
import { EventEmitter as EventEmitter7 } from "node:events";
var IPC_PATH = join4(homedir4(), ".tlive", "ipc.sock");
function attachLineParser(socket, onMessage) {
  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
      }
    }
  });
}
function sendMessage(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}
var IPCClient = class extends EventEmitter7 {
  socket = null;
  _connected = false;
  opts;
  constructor(opts = {}) {
    super();
    this.opts = {
      maxRetries: opts.maxRetries ?? 10,
      retryDelay: opts.retryDelay ?? 500,
      path: opts.path ?? IPC_PATH,
      autoReconnect: opts.autoReconnect ?? true
    };
  }
  get connected() {
    return this._connected;
  }
  /**
   * Connect to the IPC server, retrying until the bridge is ready.
   * Resolves true if connected, false if all retries exhausted.
   */
  async connect() {
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const ok = await this.tryConnect();
      if (ok) {
        if (attempt > 0) this.emit("reconnected");
        return true;
      }
      if (attempt < this.opts.maxRetries) {
        const delay = Math.min(this.opts.retryDelay * Math.pow(2, attempt), 3e4);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return false;
  }
  tryConnect() {
    return new Promise((resolve4) => {
      const socket = connect(this.opts.path, () => {
        this.socket = socket;
        this._connected = true;
        attachLineParser(socket, (msg) => this.emit(msg.type, msg.payload));
        socket.on("close", () => {
          this._connected = false;
          this.emit("disconnected");
          if (this.opts.autoReconnect) {
            setTimeout(() => this.connect(), this.opts.retryDelay);
          }
        });
        resolve4(true);
      });
      socket.on("error", () => resolve4(false));
    });
  }
  /** Send a typed message to the bridge. */
  send(type, payload = {}) {
    if (this.socket && this._connected) {
      sendMessage(this.socket, { type, payload });
    }
  }
  disconnect() {
    this.socket?.destroy();
    this.socket = null;
    this._connected = false;
  }
};

// src/config.ts
import { readFileSync as readFileSync2, existsSync as existsSync3 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join5 } from "node:path";
var DEFAULTS = {
  port: 8849,
  token: "",
  defaultProvider: "claude",
  permissionTimeout: 55e3,
  webEnabled: false,
  messageBatchDelay: 250,
  proactiveNotifyDelay: 6e4,
  proactiveQuestionDelay: 5e3,
  activeThreshold: 3e4
};
function loadConfig(envPath) {
  const configPath = envPath ?? join5(homedir5(), ".tlive", "config.env");
  const env = { ...process.env };
  if (existsSync3(configPath)) {
    const lines = readFileSync2(configPath, "utf-8").split("\n");
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
    activeThreshold: parseInt(env.TL_ACTIVE_THRESHOLD ?? "") || DEFAULTS.activeThreshold,
    telegram: env.TL_TELEGRAM_TOKEN ? { token: env.TL_TELEGRAM_TOKEN, chatId: env.TL_TELEGRAM_CHAT_ID ?? "" } : void 0,
    discord: env.TL_DISCORD_TOKEN ? { token: env.TL_DISCORD_TOKEN, channelId: env.TL_DISCORD_CHANNEL_ID ?? "" } : void 0,
    feishu: env.TL_FEISHU_APP_ID ? { appId: env.TL_FEISHU_APP_ID, appSecret: env.TL_FEISHU_APP_SECRET ?? "" } : void 0,
    proxy: env.TL_PROXY || env.HTTPS_PROXY || void 0
  };
}

// src/core/sessionDiscovery.ts
import { readdirSync, statSync as statSync2, readFileSync as readFileSync3 } from "node:fs";
import { join as join6, resolve as resolve3 } from "node:path";
import { homedir as homedir6 } from "node:os";
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function getProjectPath(workingDirectory) {
  const projectId = resolve3(workingDirectory).replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join6(homedir6(), ".claude");
  return join6(claudeConfigDir, "projects", projectId);
}
function isValidSession(projectDir, sessionId) {
  try {
    const filePath = join6(projectDir, `${sessionId}.jsonl`);
    const content = readFileSync3(filePath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.uuid && (msg.type === "user" || msg.type === "assistant")) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
  }
  return false;
}
function findLastSession(workingDirectory) {
  try {
    const projectDir = getProjectPath(workingDirectory);
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const sessionId = f.replace(".jsonl", "");
      if (!UUID_PATTERN.test(sessionId)) return null;
      if (!isValidSession(projectDir, sessionId)) return null;
      return {
        sessionId,
        mtime: statSync2(join6(projectDir, f)).mtime.getTime()
      };
    }).filter((f) => f !== null).sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].sessionId : null;
  } catch {
    return null;
  }
}

// src/core/worktreeManager.ts
import { execSync as execSync2 } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { join as join7, dirname, basename as basename2 } from "node:path";
function createWorktree(repoDir, name) {
  const repoName = basename2(repoDir);
  const sessionPrefix = name ?? `tlive-${Date.now().toString(36).slice(-4)}`;
  const worktreeDir = join7(dirname(repoDir), `${repoName}-worktrees`, sessionPrefix);
  const branch = `tlive/${sessionPrefix}`;
  if (existsSync4(worktreeDir)) {
    throw new Error(`Worktree already exists: ${worktreeDir}`);
  }
  execSync2(`git worktree add "${worktreeDir}" -b "${branch}"`, {
    cwd: repoDir,
    stdio: "pipe"
  });
  return { path: worktreeDir, branch, name: sessionPrefix };
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
function setupQR(port, token) {
  const localIP = getLocalIP();
  const url = `http://${localIP}:${port}/?token=${token}`;
  console.log("");
  console.log("  \x1B[36m\u26A1 TLive Web Terminal\x1B[0m");
  console.log("");
  console.log(`  URL: \x1B[4m${url}\x1B[0m`);
  console.log(`  Pair: \x1B[4mhttp://${localIP}:${port}/pair?token=${token}\x1B[0m`);
  console.log("");
  console.log("  Open this URL on your phone or another device.");
  console.log("  For Telegram pairing, send this to your bot:");
  console.log(`  /start pair_${token.slice(0, 16)}`);
  console.log("");
}
async function claudeCommand(opts = {}) {
  const config = loadConfig();
  const adapter = new ClaudeAdapter();
  let workdir = opts.workdir ?? process.cwd();
  if (opts.worktree) {
    try {
      const name = typeof opts.worktree === "string" ? opts.worktree : void 0;
      const wt = createWorktree(workdir, name);
      console.error(`  Worktree: ${wt.path} (${wt.branch})`);
      workdir = wt.path;
    } catch (err) {
      console.error(`  Worktree: \x1B[31mfailed\x1B[0m \u2014 ${err.message}`);
    }
  }
  let sessionId = opts.sessionId;
  if (!sessionId && opts.resume) {
    sessionId = findLastSession(workdir) ?? void 0;
    if (sessionId) {
      console.error(`  Resuming session ${sessionId.slice(0, 8)}...`);
    }
  }
  const loop = new TLiveLoop({ workdir, adapter, config, sessionId });
  const ipc = new IPCClient();
  const ipcConnected = await ipc.connect();
  if (ipcConnected) {
    ipc.send("session_register", {
      sessionId: loop.sessionInfo.sessionId,
      workdir,
      projectName: workdir.split("/").filter(Boolean).pop() ?? "unknown"
    });
  }
  loop.on("ptyData", (data) => {
    stdout.write(data);
    if (ipc.connected) {
      ipc.send("pty_data", {
        sessionId: loop.sessionInfo.sessionId,
        data
      });
    }
  });
  if (ipcConnected) {
    loop.setIMTarget("ipc", async (_chatId, text, buttons) => {
      ipc.send("notification", {
        text,
        buttons,
        sessionId: loop.sessionInfo.sessionId,
        workdir
      });
      return new Promise((resolve4) => {
        const timeout = setTimeout(() => resolve4(void 0), 3e3);
        const handler = (payload) => {
          clearTimeout(timeout);
          ipc.removeListener("message_sent", handler);
          resolve4(payload.messageId);
        };
        ipc.on("message_sent", handler);
      });
    });
    ipc.on("permission_action", (p) => {
      loop.handleIMAction(p.action, p.toolUseId);
    });
    ipc.on("terminal_input", (p) => {
      if (p.text) loop.handleTerminalInput(p.text + "\r");
    });
    ipc.on("question_answer", (p) => {
      if (p.answer !== void 0) loop.handleTerminalInput(p.answer + "\r");
    });
    ipc.on("config_update", (p) => {
      if (p.effort) console.error(`  Effort:   ${p.effort}`);
      if (p.model) console.error(`  Model:    ${p.model}`);
    });
    ipc.on("web_input", (p) => {
      if (p.data) loop.handleTerminalInput(p.data);
    });
    ipc.on("reconnected", () => console.error(`  IM:       \x1B[32mreconnected\x1B[0m`));
    console.error(`  IM:       \x1B[32mconnected\x1B[0m (bridge IPC)`);
  } else {
    console.error(`  IM:       \x1B[33mnot connected\x1B[0m (bridge not running)`);
  }
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
  }
  stdin.on("data", (data) => loop.handleTerminalInput(data.toString()));
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    if (ipc.connected) {
      ipc.send("session_unregister", { sessionId: loop.sessionInfo.sessionId });
    }
    ipc.disconnect();
    await loop.stop();
    if (stdin.isTTY) stdin.setRawMode(false);
    exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  const info = loop.sessionInfo;
  const localIP = getLocalIP();
  const webUrl = `http://${localIP}:${config.port}/?token=${config.token || info.sessionId.slice(0, 16)}`;
  console.error("");
  console.error(`  \x1B[36m\u26A1 TLive v1.0\x1B[0m`);
  console.error(`  Session:  ${info.sessionId.slice(0, 8)}...`);
  console.error(`  Workdir:  ${workdir}`);
  console.error(`  Terminal: \x1B[4m${webUrl}\x1B[0m`);
  try {
    await loop.start();
    await new Promise((resolve4) => {
      const check = setInterval(() => {
        if (loop.sessionState === "idle") {
          clearInterval(check);
          resolve4();
        }
      }, 500);
    });
  } finally {
    await cleanup();
  }
}
export {
  claudeCommand,
  setupQR
};
