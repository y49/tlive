// src/cli/ipc-client-lite.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join as join2, dirname } from "node:path";
import { homedir as homedir2 } from "node:os";
import { fileURLToPath } from "node:url";

// src/ipc.ts
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
var IPC_PATH = join(homedir(), ".tlive", "ipc.sock");
var IPC_PATH_V1 = join(homedir(), ".tlive", "ipc-v1.sock");
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
var IPCClient = class extends EventEmitter {
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
    return new Promise((resolve) => {
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
        resolve(true);
      });
      socket.on("error", () => resolve(false));
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
var IPCClientRequester = class {
  constructor(client) {
    this.client = client;
  }
  client;
  async request(req, timeoutMs = 1e4) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.client.off("response", off);
        reject(new Error(`IPC timeout (${req.type})`));
      }, timeoutMs);
      const off = (payload) => {
        if (payload.envelope.requestId !== requestId) return;
        clearTimeout(t);
        this.client.off("response", off);
        resolve(payload.envelope.message);
      };
      this.client.on("response", off);
      this.client.send("request", { envelope: { requestId, message: req } });
    });
  }
};

// src/cli/ipc-client-lite.ts
var TLIVE_HOME = join2(homedir2(), ".tlive");
var BRIDGE_PID = join2(TLIVE_HOME, "runtime", "bridge.pid");
function bridgeEntry() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join2(here, "..", "..", "bridge", "dist", "main.mjs");
}
function bridgeIsAlive() {
  if (!existsSync(BRIDGE_PID)) return false;
  const pid = parseInt(readFileSync(BRIDGE_PID, "utf-8").trim(), 10);
  if (isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function ensureDaemonRunning() {
  if (bridgeIsAlive()) return;
  const entry = bridgeEntry();
  if (!existsSync(entry)) {
    throw new Error(`Bridge not built at ${entry}. Run: npm run build:all`);
  }
  const logDir = join2(TLIVE_HOME, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join2(logDir, "bridge.log"), "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env }
  });
  child.unref();
  const client = new IPCClient({ path: IPC_PATH_V1, maxRetries: 5, retryDelay: 200, autoReconnect: false });
  const ok = await client.connect();
  client.disconnect();
  if (!ok) throw new Error("Daemon failed to start within ~6s. Check: tlive logs");
}
async function sendRequest(req) {
  let client = new IPCClient({ path: IPC_PATH_V1, maxRetries: 3, retryDelay: 200, autoReconnect: false });
  let ok = await client.connect();
  if (!ok) {
    client.disconnect();
    try {
      unlinkSync(BRIDGE_PID);
    } catch {
    }
    await ensureDaemonRunning();
    client = new IPCClient({ path: IPC_PATH_V1, maxRetries: 3, retryDelay: 200, autoReconnect: false });
    ok = await client.connect();
  }
  if (!ok) throw new Error("Failed to connect to daemon IPC after retry");
  try {
    const requester = new IPCClientRequester(client);
    return await requester.request(req);
  } finally {
    client.disconnect();
  }
}

// src/cli/claude.ts
async function claudeCommand(opts = {}) {
  await ensureDaemonRunning();
  const resp = await sendRequest({
    type: "create_session",
    payload: {
      provider: "claude",
      workdir: opts.workdir ?? process.cwd(),
      initialPrompt: opts.prompt,
      model: opts.model,
      effort: opts.effort
    }
  });
  if (resp.type === "session_created") {
    process.stdout.write(`session ${resp.payload.sessionId} started
`);
    process.stdout.write(`\u2192 continue in your IM client (Telegram/Discord/Feishu)
`);
  } else if (resp.type === "error") {
    process.stderr.write(`error: ${resp.payload.message}
`);
    process.exit(1);
  }
}
if (process.argv[1]?.endsWith("tlive-claude.mjs")) {
  const args = process.argv.slice(2);
  const opts = {};
  while (args.length) {
    const a = args.shift();
    if (a === "--workdir") opts.workdir = args.shift();
    else if (a === "--model") opts.model = args.shift();
    else if (a === "--effort") opts.effort = args.shift();
    else if (!opts.prompt) opts.prompt = a;
  }
  await claudeCommand(opts);
}
export {
  claudeCommand
};
