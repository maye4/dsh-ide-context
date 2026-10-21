// src/index.ts
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// src/constants.ts
import { homedir } from "node:os";
import { join } from "node:path";
var name = "ide-context";
var inject = ["agents"];
var DEFAULT_LOCK_DIR = join(homedir(), ".claude", "ide");
var LOCK_SCAN_INTERVAL_MS = 2e3;
var MAX_RECONNECT_DELAY_MS = 3e4;
var PROTOCOL_VERSION = "2024-11-05";
var WS_SUBPROTOCOL = "mcp";
var DATA_READY_TIMEOUT_MS = 1500;
var READING_PREFIX = "ide context (turn ";
var OPENED_FILES_TOOLS = ["get_all_opened_file_paths", "getOpenEditors"];
var SELECTION_TOOLS = ["getLatestSelection", "getCurrentSelection"];
var MAX_SELECTION_TEXT_CHARS = 8e3;

// src/lock.ts
import { readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/platform.ts
import { readFileSync } from "node:fs";
import { resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
function detectPlatform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") {
    try {
      const proc = readFileSync("/proc/version", "utf8").toLowerCase();
      if (proc.includes("microsoft") || proc.includes("wsl")) return "wsl";
    } catch {
    }
    return "linux";
  }
  return "unknown";
}
var SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
function normalizeDriveLetter(path) {
  return path.replace(/^[a-zA-Z]:/, (match) => match.toUpperCase());
}
var posix = {
  normalizePath: resolve,
  separator: sep,
  isWithinRoot(path, root) {
    const p = posix.normalizePath(path);
    const r = posix.normalizePath(root);
    if (p === r) return true;
    return p.startsWith(`${r}${posix.separator}`);
  },
  fileUriToPath(uri) {
    if (!SCHEME_RE.test(uri)) return uri;
    if (!uri.startsWith("file://")) return void 0;
    const rest = uri.slice("file://".length);
    try {
      return fileURLToPath(uri);
    } catch {
      return decodeURIComponentFallback(rest);
    }
  },
  isDiskPath(path) {
    return SCHEME_RE.test(path) ? path.startsWith("file://") : true;
  }
};
var win32Behavior = {
  normalizePath(path) {
    return normalizeDriveLetter(win32.resolve(path));
  },
  separator: win32.sep,
  isWithinRoot(path, root) {
    const p = win32Behavior.normalizePath(path);
    const r = win32Behavior.normalizePath(root);
    if (p === r) return true;
    return p.startsWith(`${r}${win32Behavior.separator}`);
  },
  fileUriToPath(uri) {
    if (!SCHEME_RE.test(uri)) {
      return uri.includes("\\") ? uri.replace(/\\/g, "/") : uri;
    }
    if (!uri.toLowerCase().startsWith("file://")) return void 0;
    try {
      return fileURLToPath(uri);
    } catch {
      const rest = uri.slice("file://".length);
      return decodeURIComponentFallback(rest).replace(/^\//, "");
    }
  },
  isDiskPath(path) {
    if (!SCHEME_RE.test(path)) return true;
    if (path.toLowerCase().startsWith("file://")) return true;
    return false;
  }
};
var detected;
function getPlatform() {
  return detected ??= detectPlatform();
}
var behavior;
function currentBehavior() {
  if (behavior !== void 0) return behavior;
  const platform = getPlatform();
  behavior = platform === "windows" ? win32Behavior : posix;
  return behavior;
}
function decodeURIComponentFallback(rest) {
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}
function isWithinRoot(path, root) {
  return currentBehavior().isWithinRoot(path, root);
}
function fileUriToPath(uri) {
  return currentBehavior().fileUriToPath(uri);
}
function isDiskPath(path) {
  return currentBehavior().isDiskPath(path);
}

// src/lock.ts
function scanLocks(lockDir, logger) {
  let entries;
  try {
    entries = readdirSync(lockDir);
  } catch (error) {
    logger.warn(`ide-context: cannot read lock directory ${lockDir}: ${error instanceof Error ? error.message : String(error)}`);
    return void 0;
  }
  const candidates = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".lock")) continue;
    const path = join2(lockDir, entry);
    let mtime;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const fileName = path.split(/[\\/]/).pop();
    if (fileName === void 0) continue;
    const port = Number(fileName.replace(".lock", ""));
    if (!Number.isInteger(port) || port <= 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync2(path, "utf8"));
    } catch (error) {
      logger.warn(`ide-context: unreadable lock file ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const root = parsed;
    if (typeof root.authToken !== "string" || root.authToken.length === 0) continue;
    const folders = Array.isArray(root.workspaceFolders) ? root.workspaceFolders.filter((item) => typeof item === "string") : [];
    candidates.push({
      path,
      mtime,
      lock: {
        port,
        ideName: typeof root.ideName === "string" ? root.ideName : void 0,
        pid: typeof root.pid === "number" ? root.pid : void 0,
        workspaceFolders: folders,
        authToken: root.authToken,
        runningInWindows: root.runningInWindows === true
      }
    });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates;
}
function scanLatestLock(lockDir, logger) {
  return scanLocks(lockDir, logger)?.[0]?.lock;
}
function selectLockByWorkspace(candidates, cwd) {
  if (cwd !== void 0) {
    let best;
    for (const candidate of candidates) {
      if (!candidate.lock.workspaceFolders.some((folder) => isWithinRoot(cwd, folder))) continue;
      if (best === void 0 || candidate.mtime > best.mtime) best = candidate;
    }
    if (best !== void 0) return best;
  }
  return candidates[0];
}
function filterFilesUnderRoots(files, roots) {
  if (roots.length === 0) return files;
  return files.filter((file) => roots.some((root) => isWithinRoot(file, root)));
}
function uniqueRoots(roots) {
  const out = [];
  for (const root of roots) {
    if (root.length === 0) continue;
    if (out.some((existing) => isWithinRoot(root, existing))) continue;
    out.push(root);
  }
  return out;
}

// src/protocol.ts
function extractOpenedFiles(result) {
  const content = extractToolText(result);
  if (content === void 0) return void 0;
  const trimmed = content.trim();
  const parsed = parseJson(trimmed);
  if (parsed !== null && typeof parsed === "object") {
    return extractFilePaths(parsed);
  }
  const files = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("[") && !line.startsWith("{"));
  return files.length > 0 ? files : void 0;
}
function extractSelectionToolResult(result) {
  const text = extractToolText(result);
  if (text === void 0) return void 0;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return void 0;
  }
  const filePath = typeof data.filePath === "string" ? data.filePath : void 0;
  if (filePath === void 0) return void 0;
  const selection = data.selection;
  const selectedText = typeof data.text === "string" ? data.text : "";
  if (selection === null || selection === void 0) return void 0;
  if (selection.isEmpty === true) return void 0;
  const start = selection.start;
  const end = selection.end;
  if (start === void 0 || end === void 0) return void 0;
  const startLine = Number(start.line) || 0;
  const startChar = Number(start.character) || 0;
  const endLine = Number(end.line) || 0;
  const endChar = Number(end.character) || 0;
  if (startLine === 0 && startChar === 0 && endLine === 0 && endChar === 0 && selectedText.length === 0) {
    return void 0;
  }
  return {
    filePath,
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
    text: selectedText
  };
}
function extractToolText(result) {
  if (result === null || typeof result !== "object") return void 0;
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
    return void 0;
  }
  const text = result.text;
  return typeof text === "string" ? text : void 0;
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function extractFilePaths(parsed) {
  const items = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" && Array.isArray(parsed.tabs) ? parsed.tabs : void 0;
  if (items === void 0) return [];
  return items.map((item) => itemFilePath(item)).filter((file) => typeof file === "string" && file.length > 0);
}
function itemFilePath(item) {
  if (typeof item === "string") return fileUriToPath(item);
  if (item === null || typeof item !== "object") return void 0;
  const record = item;
  if (typeof record.fileName === "string" && isDiskPath(record.fileName)) return record.fileName;
  if (typeof record.path === "string" && isDiskPath(record.path)) return record.path;
  if (typeof record.uri === "string") return fileUriToPath(record.uri);
  return void 0;
}

// src/types.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  refreshIntervalMs: z.number(),
  pollIntervalMs: z.number(),
  lockDir: z.string()
});
function validatePositiveInteger(value, field) {
  if (value !== void 0 && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`ide-context: ${field} must be a non-negative safe integer, got ${String(value)}`);
  }
}

// src/ws.ts
import crypto from "node:crypto";
import http from "node:http";
var RawWs = class {
  constructor(url, headers, callbacks = {}) {
    this.url = url;
    this.headers = headers;
    this.callbacks = callbacks;
  }
  url;
  headers;
  callbacks;
  socket;
  buffer = Buffer.alloc(0);
  closed = false;
  /** Open the WebSocket connection (RFC 6455 handshake). */
  connect() {
    const u = new URL(this.url);
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname || "/",
      headers: {
        Host: `${u.hostname}:${u.port}`,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Protocol": WS_SUBPROTOCOL,
        ...this.headers
      }
    });
    req.on("upgrade", (_res, socket) => {
      this.socket = socket;
      socket.on("data", (chunk) => {
        this.consume(chunk);
      });
      socket.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          this.callbacks.onclose?.(1006, "socket closed");
        }
      });
      socket.on("error", (error) => this.callbacks.onerror?.(error));
      this.callbacks.onopen?.();
    });
    req.on("response", (res) => {
      this.callbacks.onerror?.(new Error(`handshake rejected: HTTP ${res.statusCode}`));
      res.resume();
    });
    req.on("error", (error) => this.callbacks.onerror?.(error));
    req.end();
  }
  /** Send one masked text frame. */
  send(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    for (let i = 0; i < payload.length; i++) {
      const byte = payload[i] ?? 0;
      const key = mask[i % 4] ?? 0;
      payload[i] = byte ^ key;
    }
    let header;
    if (payload.length < 126) {
      header = Buffer.from([128 | 1, 128 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 128 | 1;
      header[1] = 128 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 128 | 1;
      header[1] = 128 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket?.write(Buffer.concat([header, mask, payload]));
  }
  /** Close the connection (client-initiated). */
  close() {
    this.closed = true;
    this.socket?.end();
  }
  /** True when the connection is established and not closed. */
  isOpen() {
    return !this.closed && this.socket !== void 0;
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0] ?? 0;
      const secondByte = this.buffer[1] ?? 0;
      const opcode = firstByte & 15;
      let length = secondByte & 127;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 1) {
        this.callbacks.onmessage?.(payload.toString("utf8"));
      } else if (opcode === 9) {
        const pong = Buffer.concat([Buffer.from([138]), Buffer.from([payload.length]), payload]);
        this.socket?.write(pong);
      } else if (opcode === 8) {
        this.closed = true;
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
        this.callbacks.onclose?.(code, reason);
      }
    }
  }
};

// src/bridge.ts
var IdeBridge = class {
  constructor(lockDir, pollIntervalMs, logger) {
    this.lockDir = lockDir;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    validatePositiveInteger(pollIntervalMs, "pollIntervalMs");
  }
  lockDir;
  pollIntervalMs;
  logger;
  snapshot = {
    ideName: void 0,
    workspaceFolders: [],
    openedFiles: []
  };
  /** Roots every opened file / selection must live under; empty means no filter. */
  workspaceRoots = [];
  ws;
  knownTools = [];
  lockPath;
  /** Session working directory the bridge currently follows; `undefined` until first follow call. */
  cwd;
  /** Workspace folders of the lock currently selected (to detect same-port content changes). */
  selectedFolders = [];
  nextRequestId = 1;
  pending = /* @__PURE__ */ new Map();
  lockTimer;
  pollTimer;
  reconnectDelayMs = 500;
  disposed = false;
  /** Waiters blocking `awaitLatest` until substantive data (files/selection) arrives. */
  readyWaiters = /* @__PURE__ */ new Set();
  /** Change listeners (composer-chip streams); called synchronously, must not throw. */
  changeListeners = /* @__PURE__ */ new Set();
  // -------------------------------------------------------------------------
  // Snapshot reads
  // -------------------------------------------------------------------------
  /**
   * Latest IDE snapshot, or `undefined` before any substantive data arrived.
   * `ideName` alone is connection metadata, not context.
   */
  latest() {
    const { snapshot } = this;
    if (snapshot.openedFiles.length === 0 && snapshot.selection === void 0) {
      return void 0;
    }
    return snapshot;
  }
  /**
   * Resolve to the latest snapshot, blocking up to `timeoutMs` for the first
   * substantive data to arrive. When opened files arrive before the selection
   * (push-only IDEs deliver `selection_changed` slightly later), it keeps
   * waiting within the same deadline so the first step still carries the
   * selection rather than a files-only snapshot.
   */
  async awaitLatest(timeoutMs) {
    validatePositiveInteger(timeoutMs, "timeoutMs");
    const deadline = Date.now() + timeoutMs;
    const gotAny = await this.waitFor(() => this.latest() !== void 0, deadline);
    if (!gotAny) return void 0;
    if (this.snapshot.selection === void 0 && Date.now() < deadline) {
      await this.waitFor(() => this.snapshot.selection !== void 0, deadline);
    }
    return this.latest();
  }
  /**
   * Wait until `predicate()` is true or `deadline` passes. Resolves `true` once
   * the predicate holds, `false` on timeout/dispose. Wake-ups come from
   * {@link notifyData}, which fires whenever files or selection change.
   */
  waitFor(predicate, deadline) {
    if (predicate()) return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve2) => {
      let settled = false;
      const remaining = Math.max(0, deadline - Date.now());
      const done = () => {
        if (settled) return;
        settled = true;
        this.readyWaiters.delete(onData);
        clearTimeout(timer);
        resolve2(predicate());
      };
      const onData = () => {
        done();
      };
      const timer = setTimeout(done, remaining);
      this.readyWaiters.add(onData);
    });
  }
  /** Wake any {@link awaitLatest} waiters once files/selection have arrived. */
  /**
   * Subscribe to snapshot / connection changes. Listeners are told *that*
   * something may have changed (they re-read {@link latest}/{@link status});
   * calls can be redundant, so consumers dedupe.
   * @returns the disposer removing the listener.
   */
  onChange(listener) {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }
  /** Number of live change listeners (diagnostics / leak tests). */
  listenerCount() {
    return this.changeListeners.size;
  }
  emitChange() {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
      }
    }
  }
  notifyData() {
    this.emitChange();
    const { snapshot } = this;
    if (snapshot.openedFiles.length === 0 && snapshot.selection === void 0) return;
    for (const waiter of this.readyWaiters) waiter();
    this.readyWaiters.clear();
  }
  /**
   * Connection facts for the composer chip: whether a lock was selected for the
   * followed workspace and whether the single IDE socket is open. Read-only; it
   * never opens a connection of its own.
   */
  status() {
    return {
      lockFound: this.lockPath !== void 0,
      connected: this.ws?.isOpen() === true,
      ideName: this.snapshot.ideName,
      workspaceFolders: [...this.selectedFolders]
    };
  }
  /** The working directory the bridge currently follows. */
  followedWorkspace() {
    return this.cwd;
  }
  // -------------------------------------------------------------------------
  // Workspace selection
  // -------------------------------------------------------------------------
  /**
   * Re-select the lock by a session working directory. The selected lock is
   * identified by its port *and* workspace folders — a same-port lock whose
   * `workspaceFolders` changed (same window switched projects) still rebuilds.
   */
  followWorkspace(cwd) {
    if (this.disposed) return;
    this.cwd = cwd;
    this.reselect();
  }
  reselect() {
    if (this.disposed) return;
    const candidates = scanLocks(this.lockDir, this.logger) ?? [];
    const selected = selectLockByWorkspace(candidates, this.cwd);
    const lock = selected?.lock;
    const folders = lock?.workspaceFolders ?? [];
    if (lock !== void 0 && this.sameSelection(lock.port, folders) && this.ws?.isOpen() === true) return;
    this.adoptLock(selected);
  }
  sameSelection(port, folders) {
    const path = `${port}.lock`;
    if (path !== this.lockPath) return false;
    if (folders.length !== this.selectedFolders.length) return false;
    for (let i = 0; i < folders.length; i++) {
      if (folders[i] !== this.selectedFolders[i]) return false;
    }
    return true;
  }
  adoptLock(selected) {
    const lock = selected?.lock;
    const folders = lock?.workspaceFolders ?? [];
    this.lockPath = selected === void 0 ? void 0 : `${lock?.port}.lock`;
    this.selectedFolders = folders;
    this.knownTools = [];
    this.workspaceRoots = uniqueRoots([...folders, ...this.cwd !== void 0 ? [this.cwd] : []]);
    this.snapshot = {
      ideName: lock?.ideName,
      workspaceFolders: folders,
      openedFiles: []
    };
    if (lock !== void 0) this.connect(lock);
    this.emitChange();
  }
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    this.rescan();
    this.lockTimer = setInterval(() => {
      this.rescan();
    }, LOCK_SCAN_INTERVAL_MS);
    this.pollTimer = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);
  }
  dispose() {
    this.disposed = true;
    if (this.lockTimer !== void 0) clearInterval(this.lockTimer);
    if (this.pollTimer !== void 0) clearInterval(this.pollTimer);
    this.ws?.close();
    this.ws = void 0;
  }
  rescan() {
    this.reselect();
  }
  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  connect(lock) {
    this.ws?.close();
    const url = `ws://127.0.0.1:${lock.port}`;
    this.logger.debug(`ide-context: connecting to ${url} (${lock.ideName ?? "IDE"})`);
    const ws = new RawWs(url, { "X-Claude-Code-Ide-Authorization": lock.authToken });
    this.ws = ws;
    ws.callbacks.onopen = () => {
      this.emitChange();
      this.reconnectDelayMs = 500;
      this.logger.debug("ide-context: websocket connected");
      void this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "@deepseek-ai/dsh-ide-context", version: "0.1.0" }
      }).then((result) => {
        if (result !== void 0 && typeof result === "object" && result.error === void 0) {
          this.ws?.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
          void this.rpc("tools/list", {}).then((toolsResult) => {
            this.handleToolsList(toolsResult);
          });
        }
      });
    };
    ws.callbacks.onmessage = (raw) => {
      this.handleMessage(raw);
    };
    ws.callbacks.onclose = (code, reason) => {
      this.emitChange();
      this.logger.warn(`ide-context: connection closed (${code} ${reason}); will retry`);
      this.scheduleReconnect();
    };
    ws.callbacks.onerror = (error) => {
      this.logger.warn(`ide-context: connection error: ${error.message}`);
      this.scheduleReconnect();
    };
    ws.connect();
  }
  scheduleReconnect() {
    if (this.disposed) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    setTimeout(() => {
      if (this.disposed) return;
      this.reselect();
    }, delay);
  }
  // -------------------------------------------------------------------------
  // JSON-RPC
  // -------------------------------------------------------------------------
  rpc(method, params) {
    const id = String(this.nextRequestId++);
    return new Promise((resolve2) => {
      this.pending.set(id, resolve2);
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : void 0;
    if (message.id !== void 0 && method !== void 0 && message.result === void 0 && message.error === void 0) {
      this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      return;
    }
    if (typeof message.id === "string" && this.pending.has(message.id)) {
      const resolve2 = this.pending.get(message.id);
      if (resolve2 !== void 0) {
        this.pending.delete(message.id);
        resolve2(message.error ?? message.result);
      }
      return;
    }
    if (method === "selection_changed") {
      this.applySelectionChanged(message.params);
    }
  }
  // -------------------------------------------------------------------------
  // Incoming selection
  // -------------------------------------------------------------------------
  applySelectionChanged(params) {
    const p = params;
    if (p === void 0) return;
    const filePath = typeof p.filePath === "string" ? p.filePath : void 0;
    const selection = p.selection;
    const text = typeof p.text === "string" ? p.text : "";
    if (filePath === void 0) return;
    if (!this.isInWorkspace(filePath)) return;
    if (selection === null || selection === void 0) {
      this.snapshot.selection = { filePath, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text };
      this.notifyData();
      return;
    }
    const start = selection.start;
    const end = selection.end;
    if (start === void 0 || end === void 0) return;
    this.snapshot.selection = {
      filePath,
      start: { line: Number(start.line) || 0, character: Number(start.character) || 0 },
      end: { line: Number(end.line) || 0, character: Number(end.character) || 0 },
      text
    };
    this.notifyData();
  }
  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------
  poll() {
    if (this.ws === void 0 || this.disposed) return;
    void this.refreshOpenedFiles();
    void this.refreshSelection();
  }
  async refreshOpenedFiles() {
    const tool = OPENED_FILES_TOOLS.find((candidate) => this.knownTools.includes(candidate));
    if (tool === void 0) return;
    const result = await this.rpc("tools/call", { name: tool, arguments: {} });
    const files = extractOpenedFiles(result);
    if (files !== void 0) {
      this.snapshot.openedFiles = filterFilesUnderRoots(files, this.workspaceRoots);
      this.notifyData();
    }
  }
  async refreshSelection() {
    const tool = SELECTION_TOOLS.find((candidate) => this.knownTools.includes(candidate));
    if (tool === void 0) return;
    const result = await this.rpc("tools/call", { name: tool, arguments: {} });
    const selection = extractSelectionToolResult(result);
    if (selection === void 0) return;
    if (!this.isInWorkspace(selection.filePath)) return;
    this.snapshot.selection = selection;
    this.notifyData();
  }
  isInWorkspace(path) {
    return this.workspaceRoots.length === 0 || this.workspaceRoots.some((root) => isWithinRoot(path, root));
  }
  setKnownTools(tools) {
    this.knownTools = tools;
    this.logger.debug(`ide-context: IDE tools: ${tools.join(", ")}`);
    void this.refreshOpenedFiles();
    void this.refreshSelection();
  }
  handleToolsList(result) {
    const tools = result?.tools;
    if (!Array.isArray(tools)) return;
    this.setKnownTools(tools.map((tool) => typeof tool.name === "string" ? tool.name : ""));
  }
};

// src/format.ts
var claudeSelectionStrategy = {
  render(selection) {
    if (selection.start.line === 0 && selection.start.character === 0 && selection.end.line === 0 && selection.end.character === 0 && selection.text.length === 0) {
      return void 0;
    }
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const linesLabel = startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`;
    const lines = [`The user selected ${linesLabel} from ${selection.filePath}:`];
    if (selection.text.length > MAX_SELECTION_TEXT_CHARS) {
      lines.push(selection.text.slice(0, MAX_SELECTION_TEXT_CHARS));
      lines.push(`[selection truncated: showing ${MAX_SELECTION_TEXT_CHARS} of ${selection.text.length} characters; read the file for the rest]`);
    } else if (selection.text.length > 0) {
      lines.push(selection.text);
    }
    lines.push("");
    lines.push("This may or may not be related to the current task.");
    return lines.join("\n");
  }
};
function renderState(snapshot, strategy = claudeSelectionStrategy) {
  const lines = [];
  if (snapshot.ideName !== void 0) lines.push(`ide: ${snapshot.ideName}`);
  if (snapshot.openedFiles.length > 0) {
    lines.push(`opened files (${snapshot.openedFiles.length}):`);
    for (const file of snapshot.openedFiles) lines.push(`- ${file}`);
  }
  const selection = snapshot.selection;
  if (selection !== void 0) {
    const rendered = strategy.render(selection);
    if (rendered !== void 0) lines.push(rendered);
  }
  return lines.join("\n");
}
function renderReading(snapshot, turn, strategy) {
  return `${READING_PREFIX}${turn}):
${renderState(snapshot, strategy)}`;
}

// src/toggles.ts
import { mkdirSync, readFileSync as readFileSync3, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var MAX_REMEMBERED_SESSIONS = 500;
var SessionToggles = class {
  constructor(file) {
    this.file = file;
    this.disabled = [];
    if (file === void 0) return;
    try {
      const parsed = JSON.parse(readFileSync3(file, "utf8"));
      if (Array.isArray(parsed.disabled)) {
        for (const id of parsed.disabled) if (typeof id === "string") this.disabled.push(id);
      }
    } catch {
    }
  }
  file;
  disabled;
  listeners = /* @__PURE__ */ new Set();
  /** True unless the session was switched off. */
  isEnabled(sessionId) {
    return sessionId === void 0 || !this.disabled.includes(sessionId);
  }
  /** Subscribe to switch flips; returns the disposer. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Switch one session on/off; returns the new enabled value. */
  set(sessionId, enabled) {
    const index = this.disabled.indexOf(sessionId);
    if (enabled && index !== -1) this.disabled.splice(index, 1);
    if (!enabled && index === -1) {
      this.disabled.push(sessionId);
      while (this.disabled.length > MAX_REMEMBERED_SESSIONS) this.disabled.shift();
    }
    this.save();
    for (const listener of [...this.listeners]) {
      try {
        listener(sessionId);
      } catch {
      }
    }
    return enabled;
  }
  save() {
    if (this.file === void 0) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ disabled: this.disabled }, null, 2), "utf8");
    } catch {
    }
  }
};

// src/chip.ts
function baseName(path) {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length === 0 ? path : parts[parts.length - 1] ?? path;
}
function hasSelection(snapshot) {
  const selection = snapshot?.selection;
  return selection !== void 0 && selection.text.length > 0;
}
function selectedLineCount(start, end) {
  const count = end.line - start.line + 1;
  return end.character === 0 && end.line > start.line ? count - 1 : count;
}
function computeChipState(input) {
  const { enabled, bridge, snapshot, previousState } = input;
  const ideName = bridge.ideName ?? snapshot?.ideName;
  const base = { enabled, status: "disconnected", ...ideName !== void 0 ? { ideName } : {} };
  if (!bridge.lockFound || !bridge.connected) return base;
  const state = snapshot === void 0 ? "" : renderState(snapshot);
  const pending = state.length > 0 && state !== previousState;
  if (!hasSelection(snapshot)) return { ...base, status: "no-selection", pending };
  const { selection } = snapshot;
  const lineCount = selectedLineCount(selection.start, selection.end);
  const startLine = selection.start.line + 1;
  const endLine = startLine + lineCount - 1;
  const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
  return {
    ...base,
    status: "selection",
    filePath: selection.filePath,
    label: `${baseName(selection.filePath)}:${range}`,
    startLine,
    endLine,
    lineCount,
    chars: selection.text.length,
    truncated: selection.text.length > MAX_SELECTION_TEXT_CHARS,
    pending
  };
}

// src/web.ts
var ROUTE_PREFIX = "/ide-context/api";
var CLIENT_HEADER = "x-dsh-ide-context";
var PUSH_THROTTLE_MS = 50;
var HEARTBEAT_MS = 2e4;
var REFOLLOW_MS = 1e4;
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function isAllowedRequest(req) {
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK.has(hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  return req.headers[CLIENT_HEADER] === "1";
}
function stateFor(deps, sessionId, options = {}) {
  const session = sessionId === void 0 ? void 0 : safeGet(deps, sessionId);
  const cwd = session?.header.cwd;
  if (cwd !== void 0 && options.follow !== false) deps.bridge.followWorkspace(cwd);
  return computeChipState({
    enabled: deps.toggles.isEnabled(sessionId),
    bridge: deps.bridge.status(),
    snapshot: deps.bridge.latest(),
    previousState: session === void 0 ? void 0 : safePrevious(deps, session)
  });
}
function safeGet(deps, id) {
  try {
    return deps.getSession(id);
  } catch {
    return void 0;
  }
}
function safePrevious(deps, session) {
  try {
    return deps.previousState(session);
  } catch {
    return void 0;
  }
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function openStream(deps, req, res, sessionId, counter) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no",
    connection: "keep-alive"
  });
  res.flushHeaders?.();
  let closed = false;
  let last = "";
  let lastPushAt = 0;
  let pending;
  const push = (follow) => {
    if (closed) return;
    lastPushAt = Date.now();
    const json = JSON.stringify(stateFor(deps, sessionId, { follow }));
    if (json === last) return;
    last = json;
    res.write(`data: ${json}

`);
  };
  const schedule = () => {
    if (closed || pending !== void 0) return;
    const wait = PUSH_THROTTLE_MS - (Date.now() - lastPushAt);
    if (wait <= 0) return push(false);
    pending = setTimeout(() => {
      pending = void 0;
      push(false);
    }, wait);
  };
  const offBridge = deps.bridge.onChange?.(schedule);
  const offToggles = deps.toggles.onChange((id) => {
    if (id === sessionId) schedule();
  });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": hb\n\n");
  }, HEARTBEAT_MS);
  const refollow = setInterval(() => {
    push(true);
  }, REFOLLOW_MS);
  if (counter !== void 0) counter.open++;
  const dispose = () => {
    if (closed) return;
    closed = true;
    if (counter !== void 0) counter.open--;
    offBridge?.();
    offToggles();
    clearInterval(heartbeat);
    clearInterval(refollow);
    if (pending !== void 0) clearTimeout(pending);
    try {
      res.end();
    } catch {
    }
  };
  req.on("close", dispose);
  res.on("close", dispose);
  res.on("error", dispose);
  push(true);
  lastPushAt = 0;
  return dispose;
}
function createHandler(deps) {
  const streams = { open: 0 };
  const handler = async (req, res) => {
    try {
      if (!isAllowedRequest(req)) return send(res, 403, { ok: false, error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://local");
      const method = url.pathname.slice(ROUTE_PREFIX.length);
      if (req.method === "GET" && method === "/events") {
        const session = url.searchParams.get("session") ?? "";
        openStream(deps, req, res, session === "" ? void 0 : session, streams);
        return;
      }
      if (req.method === "GET" && method === "/state") {
        const session = url.searchParams.get("session") ?? void 0;
        return send(res, 200, { ok: true, value: stateFor(deps, session === "" ? void 0 : session) });
      }
      if (req.method === "POST" && method === "/toggle") {
        const parsed = JSON.parse(await readBody(req));
        if (typeof parsed.session !== "string" || parsed.session.length === 0 || typeof parsed.enabled !== "boolean") {
          return send(res, 400, { ok: false, error: "expected { session: string, enabled: boolean }" });
        }
        deps.toggles.set(parsed.session, parsed.enabled);
        return send(res, 200, { ok: true, value: stateFor(deps, parsed.session) });
      }
      return send(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return Object.assign(handler, { streams });
}

// src/index.ts
function latestInjectedState(agent) {
  return latestInjectedStateOf(agent.session);
}
function latestInjectedStateOf(session) {
  const events = session.snapshotEvents?.() ?? [];
  for (const event of [...events].reverse()) {
    if (event.type === "user/message" && event.data.source.kind === name) {
      const [block] = event.data.content;
      if (block?.type !== "text") return void 0;
      const newline = block.text.indexOf("\n");
      const state = newline === -1 ? "" : block.text.slice(newline + 1);
      return { state, time: event.time };
    }
  }
  return void 0;
}
async function readSnapshot(bridge, timeoutMs) {
  if (typeof bridge.awaitLatest === "function") return await bridge.awaitLatest(timeoutMs);
  return bridge.latest();
}
function apply(ctx, config) {
  const refreshIntervalMs = config.refreshIntervalMs;
  const pollIntervalMs = config.pollIntervalMs ?? 5e3;
  const lockDir = config.lockDir ?? DEFAULT_LOCK_DIR;
  const toggles = new SessionToggles(join3(homedir2(), ".dsh", "ide-context", "sessions.json"));
  validatePositiveInteger(refreshIntervalMs, "refreshIntervalMs");
  validatePositiveInteger(pollIntervalMs, "pollIntervalMs");
  const bridge = ctx.get("ideContext") ?? new IdeBridge(lockDir, pollIntervalMs, ctx.logger);
  if (ctx.get("ideContext") === void 0) {
    ctx.provide("ideContext", bridge);
    ctx.effect(() => {
      bridge.start();
      return () => {
        bridge.dispose();
      };
    }, `${name} bridge`);
  }
  ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted || step !== 1) return decision;
    if (!toggles.isEnabled(agent.session.id)) return decision;
    bridge.followWorkspace(agent.session.header.cwd);
    const previous = latestInjectedState(agent);
    if (refreshIntervalMs !== void 0 && refreshIntervalMs > 0 && previous !== void 0) {
      const now = Date.now();
      if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision;
    }
    const snapshot = await readSnapshot(bridge, DATA_READY_TIMEOUT_MS);
    if (snapshot === void 0) return decision;
    const state = renderState(snapshot);
    if (state.length === 0) return decision;
    if (previous !== void 0 && previous.state === state) return decision;
    const text = renderReading(snapshot, turn);
    return {
      kind: "enter",
      messages: [
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: name, form: "snapshot", sections: [{ name, text }] }
        }),
        ...decision.messages
      ]
    };
  }, { prepend: true });
  ctx.inject(["webServer"], (webCtx) => {
    const handler = createHandler({
      bridge,
      toggles,
      getSession: (id) => {
        const sessions = ctx.get("sessions");
        return sessions?.get(id);
      },
      previousState: (session) => latestInjectedStateOf(session)?.state
    });
    webCtx.effect(() => webCtx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler }), `${name} chip route`);
  });
}
export {
  CLIENT_HEADER,
  Config,
  IdeBridge,
  PUSH_THROTTLE_MS,
  ROUTE_PREFIX,
  SessionToggles,
  apply,
  baseName,
  computeChipState,
  createHandler,
  extractOpenedFiles,
  extractSelectionToolResult,
  filterFilesUnderRoots,
  inject,
  isAllowedRequest,
  name,
  openStream,
  renderState,
  scanLatestLock,
  scanLocks,
  selectLockByWorkspace,
  selectedLineCount,
  stateFor
};
