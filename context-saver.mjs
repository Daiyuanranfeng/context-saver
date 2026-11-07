#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
//  Context-Saver — the token-saving MCP gateway / multiplexer.
//
//  One connection. Every tool. ~90% less context.
//
//  Connect a single MCP server (this gateway) to Claude Code, Cursor or
//  Claude Desktop. It fronts any number of downstream MCP servers and
//  lazy-loads their tool schemas only when a turn actually needs them.
//
//  · Zero runtime dependencies — this entire file is the product.
//  · Transports: stdio · Streamable HTTP (POST/GET/DELETE /mcp) · legacy SSE.
//  · Embedded OAuth 2.1 authorization server (DCR + PKCE + approval pop-up).
//  · Node >= 18.17. MIT licensed.
//
//  Section index (search for "[NN]" to navigate):
//    [01] constants & environment
//    [02] utilities: logging, tokens, names, globs, PKCE, JSON-RPC
//    [03] configuration
//    [04] catalog cache
//    [05] downstream connections (stdio · streamable HTTP · legacy SSE)
//    [06] downstream manager (lazy connect, dedup, restart, idle reap)
//    [07] planner (task -> toolset scoring)
//    [08] session + gateway engine + meta-tools
//    [09] stdio transport
//    [10] HTTP transport (+ legacy /sse) & session sweep
//    [11] OAuth 2.1 provider
//    [12] built-in demo servers
//    [13] interactive REPL client
//    [14] doctor (self-diagnostic)
//    [15] CLI entry point
//    [16] exports (for tests)
// ---------------------------------------------------------------------------

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// [01] constants & environment
// ---------------------------------------------------------------------------

const VERSION = '1.0.0';
const SERVER_NAME = 'context-saver';
const SERVER_TITLE = 'Context-Saver MCP Gateway';

/** Protocol versions we speak (legacy era: initialize handshake). Newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const DEFAULT_HTTP_PORT = 3270;
const DEFAULT_HTTP_HOST = '127.0.0.1';
const HTTP_BODY_LIMIT = 4 * 1024 * 1024; // 4 MiB, matches the official SDK
const STDIO_LINE_LIMIT = 10 * 1024 * 1024; // 10 MB, matches the official SDK
const SSE_KEEPALIVE_MS = 15_000;

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Runtime knobs (env-overridable so tests can shrink timeouts). */
const SETTINGS = () => ({
  pageSize: intEnv('CONTEXT_SAVER_PAGE_SIZE', 100, { min: 1, max: 1000 }),
  sessionTtlMs: intEnv('CONTEXT_SAVER_SESSION_TTL_MS', 30 * 60_000, { min: 1_000 }),
  downstreamIdleMs: intEnv('CONTEXT_SAVER_DOWNSTREAM_IDLE_MS', 10 * 60_000, { min: 0 }),
  tokenTtlMs: intEnv('CONTEXT_SAVER_TOKEN_TTL_MS', 3_600_000, { min: 1_000 }),
  refreshTokenTtlMs: intEnv('CONTEXT_SAVER_REFRESH_TOKEN_TTL_MS', 30 * 86_400_000, { min: 1_000 }),
  logLevel: (process.env.CONTEXT_SAVER_LOG || 'info').toLowerCase(),
  cacheDir: process.env.CONTEXT_SAVER_CACHE_DIR || path.join(tmpdir(), 'context-saver-cache'),
});

const INSTRUCTIONS = [
  'Context-Saver is a lazy MCP gateway: only the 6 cs_* meta-tools are always loaded; every other tool lives on downstream servers.',
  'Workflow for each task: (1) cs_discover or cs_plan to find the right tools (cheap, no schemas);',
  '(2) cs_load exactly the tools you need — they become normal callable tools and their schemas are echoed in the result;',
  '(3) call the loaded tools directly, or use cs_call for one-off calls (auto-loads, no schema needed);',
  '(4) cs_unload when done to reclaim context; (5) cs_status for diagnostics and token savings.',
  'Never guess downstream tool names — always discover or plan first.',
].join(' ');

// ---------------------------------------------------------------------------
// [02] utilities
// ---------------------------------------------------------------------------

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** All logging goes to stderr — stdout is a protocol channel in stdio mode. */
const log = {
  _threshold: null,
  _level() {
    if (this._threshold === null) {
      const l = LOG_LEVELS[SETTINGS().logLevel];
      this._threshold = l === undefined ? LOG_LEVELS.info : l;
    }
    return this._threshold;
  },
  _write(level, tag, msg) {
    if (LOG_LEVELS[level] > this._level()) return;
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`${ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  },
  debug(tag, msg) { this._write('debug', tag, msg); },
  info(tag, msg) { this._write('info', tag, msg); },
  warn(tag, msg) { this._write('warn', tag, msg); },
  error(tag, msg) { this._write('error', tag, msg); },
};

/** Rough token estimate (~4 chars per token). Documented as an estimate. */
function estimateTokens(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s === undefined ? 0 : Math.ceil(s.length / 4);
}

/** MCP tool names must match ^[A-Za-z0-9_-]{1,128}$ downstream; we expose `server__tool`. */
function sanitizeToolName(name, maxLen = 64) {
  const clean = String(name).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+/, '').slice(0, maxLen);
  return clean || 'tool';
}

/** Simple glob: `*` matches anything, everything else is literal. */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchGlob(pattern, value) {
  if (!pattern.includes('*')) return pattern === value;
  return globToRegExp(pattern).test(value);
}

// --- PKCE (RFC 7636, S256) --------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString('base64url').replace(/=+$/, '');

function pkceChallengeFromVerifier(verifier) {
  return b64url(createHash('sha256').update(String(verifier), 'utf8').digest());
}

function verifyPkce(verifier, expectedChallenge) {
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) return false;
  const actual = pkceChallengeFromVerifier(verifier);
  const expected = String(expectedChallenge || '');
  if (actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- JSON-RPC 2.0 -----------------------------------------------------------

const ErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  SESSION_NOT_FOUND: -32001,
});

const rpcResponse = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id === undefined ? null : id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

function isJsonRpcRequest(msg) {
  return msg !== null && typeof msg === 'object' && msg.jsonrpc === '2.0' && typeof msg.method === 'string' && msg.id !== undefined;
}
function isJsonRpcNotification(msg) {
  return msg !== null && typeof msg === 'object' && msg.jsonrpc === '2.0' && typeof msg.method === 'string' && msg.id === undefined;
}

class ToolCallError extends Error { // becomes an isError:true tool result
  constructor(message, { code, hint } = {}) {
    super(message);
    this.name = 'ToolCallError';
    this.code = code;
    this.hint = hint;
  }
}
class DownstreamRpcError extends Error { // JSON-RPC error raised by a downstream server
  constructor(code, message, data) {
    super(message);
    this.name = 'DownstreamRpcError';
    this.code = code;
    this.data = data;
  }
}

/** Deterministic text tokenizer shared by the planner and discovery filter. */
const STOPWORDS = new Set(('the a an and or of to in on for with use using make makes me my mine please can could you your ' +
  'i it its is are was were be been being do does did done this that these those there here what which who whom when where ' +
  'how why all any both each few more most other some such no nor not only own same so than too very s t just don now then ' +
  'also into from at by as we our us them they he she his her him will would should shall may might must about after again ' +
  'against because before below between during further having if off once out over under until up while want wants need needs ' +
  'get gets let lets like').split(' '));

function tokenize(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
    const t = raw.replace(/^[.+-]+|[.+-]+$/g, '');
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function fmtTokens(n) {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// [03] configuration
// ---------------------------------------------------------------------------

class ConfigError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues || [];
  }
}

function findConfigFile(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        process.env.CONTEXT_SAVER_CONFIG,
        path.join(process.cwd(), 'context-saver.config.json'),
        path.join(process.cwd(), '.context-saver.json'),
        path.join(process.env.HOME || tmpdir(), '.context-saver', 'config.json'),
      ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch { /* not present */ }
  }
  return null;
}

/** Expand ${VAR} / $VAR from the environment inside config strings. */
function expandEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced, plain) => {
    const name = braced || plain;
    const val = process.env[name];
    if (val === undefined) {
      log.warn('config', `environment variable ${name} is not set; leaving literal`);
      return m;
    }
    return val;
  });
}

function normalizeServerEntry(name, raw) {
  const issues = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(`server "${name}": entry must be an object`);
    return { issues };
  }
  if (raw.disabled === true) return { spec: null, issues };

  const spec = { name, type: 'stdio' };
  const str = (v) => (typeof v === 'string' ? expandEnv(v) : undefined);

  if (typeof raw.command === 'string' && raw.command.trim() !== '') {
    spec.command = str(raw.command);
    spec.args = Array.isArray(raw.args) ? raw.args.map((a) => (typeof a === 'string' ? str(a) : String(a))) : [];
    if (raw.args !== undefined && !Array.isArray(raw.args)) issues.push(`server "${name}": "args" must be an array of strings`);
    if (raw.env !== undefined) {
      if (raw.env === null || typeof raw.env !== 'object' || Array.isArray(raw.env)) {
        issues.push(`server "${name}": "env" must be an object of string -> string`);
      } else {
        spec.env = {};
        for (const [k, v] of Object.entries(raw.env)) spec.env[k] = str(String(v));
      }
    }
    if (raw.cwd !== undefined && typeof raw.cwd === 'string') spec.cwd = str(raw.cwd);
  } else if (typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url)) {
    spec.url = str(raw.url);
    spec.type = /^sse$/i.test(String(raw.transport || '')) ? 'legacy-sse' : 'http';
    if (raw.headers !== undefined) {
      if (raw.headers === null || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
        issues.push(`server "${name}": "headers" must be an object of string -> string`);
      } else {
        spec.headers = {};
        for (const [k, v] of Object.entries(raw.headers)) spec.headers[k] = str(String(v));
      }
    }
  } else {
    issues.push(`server "${name}": needs either "command" (stdio) or "url" (http/sse)`);
    return { issues };
  }

  for (const key of ['timeoutMs', 'initTimeoutMs', 'idleMs']) {
    if (raw[key] !== undefined) {
      const n = Number(raw[key]);
      if (!Number.isFinite(n) || n <= 0) issues.push(`server "${name}": "${key}" must be a positive number`);
      else spec[key] = Math.floor(n);
    }
  }
  if (typeof raw.description === 'string') spec.description = raw.description.slice(0, 200);
  if (raw.args !== undefined && !Array.isArray(raw.args) && typeof raw.command === 'string') {
    // already reported above; keep entry usable by coercing
    spec.args = [];
  }
  return { spec, issues };
}

/** Load + validate a gateway config. Accepts both `servers` and Claude-style `mcpServers`. */
function loadConfig(configPath) {
  const resolved = findConfigFile(configPath);
  if (!resolved) {
    return { path: null, servers: {}, defaults: {} };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot parse config file ${resolved}: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`config file ${resolved} must contain a JSON object`);
  }
  const serversRaw = raw.servers ?? raw.mcpServers;
  if (serversRaw === undefined) {
    throw new ConfigError(`config file ${resolved} has neither "servers" nor "mcpServers"`);
  }
  if (serversRaw === null || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
    throw new ConfigError(`"servers"/"mcpServers" must be an object in ${resolved}`);
  }

  const issues = [];
  const servers = {};
  for (const [name, entry] of Object.entries(serversRaw)) {
    if (typeof name !== 'string' || name.trim() === '' || name.includes('__')) {
      issues.push(`server name "${name}" is invalid (must be non-empty, no "__")`);
      continue;
    }
    const { spec, issues: entryIssues } = normalizeServerEntry(name, entry);
    issues.push(...entryIssues);
    if (spec) servers[name] = spec;
  }
  if (Object.keys(servers).length === 0 && issues.length === 0) {
    log.warn('config', `no servers defined in ${resolved}`);
  }

  const defaults = {};
  if (raw.defaults && typeof raw.defaults === 'object' && !Array.isArray(raw.defaults)) {
    for (const key of ['timeoutMs', 'initTimeoutMs', 'idleMs']) {
      if (Number.isFinite(Number(raw.defaults[key]))) defaults[key] = Math.floor(Number(raw.defaults[key]));
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(`invalid config in ${resolved}`, issues);
  }
  return { path: resolved, servers, defaults };
}

// ---------------------------------------------------------------------------
// [04] catalog cache — zero-cost restarts for discovery
// ---------------------------------------------------------------------------

class CatalogCache {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'catalog-cache.json');
    this.disabled = false;
    this.warned = false;
  }
  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      const out = new Map();
      for (const [server, entry] of Object.entries(raw)) {
        if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.tools)) continue;
        out.set(server, {
          tools: entry.tools.filter((t) => t && typeof t.name === 'string'),
          fetchedAt: Number(entry.fetchedAt) || 0,
          ...(typeof entry.fingerprint === 'string' ? { fingerprint: entry.fingerprint } : {}),
        });
      }
      return out;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn('cache', `ignoring unreadable catalog cache (${err.message}); starting fresh`);
        try { renameSync(this.file, `${this.file}.corrupt`); } catch { /* best effort */ }
      }
      return new Map();
    }
  }
  save(entries) {
    if (this.disabled) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const obj = {};
      for (const [server, entry] of entries) {
        obj[server] = { tools: entry.tools, fetchedAt: entry.fetchedAt, ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}) };
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      renameSync(tmp, this.file); // atomic on POSIX; best-effort elsewhere
    } catch (err) {
      if (!this.warned) {
        log.warn('cache', `cannot persist catalog cache to ${this.file} (${err.message}); continuing without`);
        this.warned = true;
      }
      this.disabled = true;
    }
  }
}

/** Keep only spec-relevant fields of a downstream tool definition. */
function normalizeToolDef(def, serverName) {
  if (def === null || typeof def !== 'object' || typeof def.name !== 'string' || def.name === '') return null;
  const out = { name: def.name };
  if (typeof def.title === 'string') out.title = def.title;
  if (typeof def.description === 'string') out.description = def.description;
  if (def.inputSchema !== null && typeof def.inputSchema === 'object' && !Array.isArray(def.inputSchema)) {
    if (def.inputSchema.type !== 'object') {
      log.warn('downstream', `${serverName}.${def.name}: inputSchema.type is "${def.inputSchema.type}", expected "object"`);
    }
    out.inputSchema = def.inputSchema;
  } else {
    out.inputSchema = { type: 'object', properties: {} };
  }
  if (def.outputSchema !== null && typeof def.outputSchema === 'object' && !Array.isArray(def.outputSchema)) out.outputSchema = def.outputSchema;
  if (def.annotations !== null && typeof def.annotations === 'object' && !Array.isArray(def.annotations)) out.annotations = def.annotations;
  return out;
}

const DOWNSTREAM_INIT_PARAMS = () => ({
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'context-saver-gateway', version: VERSION },
});

class DownstreamTimeout extends Error {
  constructor(what, ms) { super(`${what} timed out after ${ms} ms`); this.name = 'DownstreamTimeout'; }
}
class ExitDuringCall extends Error {
  constructor(server) { super(`downstream "${server}" exited during the call`); this.name = 'ExitDuringCall'; }
}
class SessionExpired extends Error {
  constructor(server) { super(`session with downstream "${server}" expired`); this.name = 'SessionExpired'; }
}

/** Normalize a tools/call response from a downstream server. */
function normalizeCallResult(result, serverName, toolName) {
  const r = (result !== null && typeof result === 'object') ? result : {};
  const out = {};
  if (Array.isArray(r.content)) {
    out.content = r.content.filter((c) => c !== null && typeof c === 'object' && typeof c.type === 'string');
    if (out.content.length === 0) out.content = [{ type: 'text', text: JSON.stringify(r) }];
  } else {
    out.content = [{ type: 'text', text: JSON.stringify(r) }];
  }
  if (r.structuredContent !== null && typeof r.structuredContent === 'object' && !Array.isArray(r.structuredContent)) {
    out.structuredContent = r.structuredContent;
  }
  if (r.isError === true) out.isError = true;
  return out;
}

// ---------------------------------------------------------------------------
// [05] downstream connections
// ---------------------------------------------------------------------------

/** Shared tools/list pagination + tools/call semantics for all transports. */
class BaseDownstream {
  constructor(name, spec, { initTimeoutMs = 10_000, requestTimeoutMs = 60_000, onNotification } = {}) {
    this.name = name;
    this.spec = spec;
    this.type = 'stdio';
    this.state = 'idle';
    this.tools = [];
    this.lastUsed = Date.now();
    this.initTimeoutMs = initTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onNotification = onNotification || (() => {});
  }

  /** Full handshake: initialize -> initialized -> tools/list (paginated). */
  async connect() {
    this.state = 'connecting';
    const initRes = await this.request('initialize', DOWNSTREAM_INIT_PARAMS(), this.initTimeoutMs);
    if (initRes.error) throw new DownstreamRpcError(initRes.error.code ?? ErrorCode.INTERNAL_ERROR, `initialize failed: ${initRes.error.message}`);
    this.serverInfo = initRes.result?.serverInfo || {};
    this.remoteProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(initRes.result?.protocolVersion)
      ? initRes.result.protocolVersion : LATEST_PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    this.tools = await this.listTools();
    this.state = 'connected';
    log.info('downstream', `connected to "${this.name}" (${this.type}) — ${this.tools.length} tool(s)`);
    return this;
  }

  async listTools() {
    const tools = [];
    let cursor;
    let pages = 0;
    do {
      const res = await this.request('tools/list', cursor ? { cursor } : {}, 15_000);
      if (res.error) throw new DownstreamRpcError(res.error.code ?? ErrorCode.INTERNAL_ERROR, `tools/list failed: ${res.error.message}`);
      const result = res.result || {};
      if (Array.isArray(result.tools)) {
        for (const def of result.tools) {
          const norm = normalizeToolDef(def, this.name);
          if (norm) tools.push(norm);
        }
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    } while (cursor && ++pages < 64 && tools.length < 1000);
    return tools;
  }

  async callTool(toolName, args, timeoutMs = this.requestTimeoutMs) {
    const res = await this.request('tools/call', { name: toolName, arguments: args === undefined ? {} : args }, timeoutMs);
    if (res.error) {
      throw new DownstreamRpcError(res.error.code ?? ErrorCode.INTERNAL_ERROR, res.error.message ?? 'downstream tool error', res.error.data);
    }
    return normalizeCallResult(res.result, this.name, toolName);
  }

  _handleDownstreamNotification(method) {
    if (method === 'notifications/tools/list_changed') {
      log.info('downstream', `"${this.name}" reports tools/list_changed — refreshing catalog`);
      clearTimeout(this._listRefreshTimer);
      this._listRefreshTimer = setTimeout(() => {
        this.listTools()
          .then((tools) => { this.tools = tools; this.onNotification({ kind: 'catalog-refresh', server: this.name, tools }); })
          .catch((err) => log.warn('downstream', `"${this.name}" catalog refresh failed: ${err.message}`));
      }, 200);
    }
  }
}

/** Downstream over a spawned stdio process (the common local case). */
class StdioDownstream extends BaseDownstream {
  constructor(name, spec, opts) {
    super(name, spec, opts);
    this.type = 'stdio';
    this.pending = new Map();
    this._idSeq = 0;
    this._writeChain = Promise.resolve();
    this._stderrLines = 0;
  }

  async connect() {
    const env = { ...process.env, ...(this.spec.env || {}) };
    this.proc = spawn(this.spec.command, this.spec.args || [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}),
    });
    this.proc.on('error', (err) => this._onExit(new ToolCallError(`cannot spawn "${this.spec.command}": ${err.message}`)));
    this.proc.on('exit', (code, signal) => this._onExit(null, code, signal));
    this.proc.stdout.on('error', () => {});
    this.proc.stdin.on('error', () => {}); // downstream may close stdin first

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._onLine(line));

    const rlErr = readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity });
    rlErr.on('line', (line) => {
      if (this._stderrLines < 200) {
        this._stderrLines += 1;
        log.debug(`server:${this.name}`, line.slice(0, 500));
      } else if (this._stderrLines === 200) {
        this._stderrLines += 1;
        log.debug(`server:${this.name}`, '(stderr suppressed after 200 lines)');
      }
    });
    return super.connect();
  }

  _onExit(spawnError, code, signal) {
    if (this.state === 'closed') return;
    const was = this.state;
    this.state = 'closed';
    const reason = spawnError ? spawnError.message : `exited (${signal ? `signal ${signal}` : `code ${code ?? '?'}`})`;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new ExitDuringCall(this.name));
    }
    if (was !== 'idle') log.info('downstream', `"${this.name}" ${reason}`);
  }

  _onLine(line) {
    if (!line.trim()) return;
    if (line.length > STDIO_LINE_LIMIT) { log.warn('downstream', `"${this.name}" sent an oversized line; skipping`); return; }
    let msg;
    try { msg = JSON.parse(line); } catch { log.debug('downstream', `"${this.name}" sent a non-JSON line; skipping`); return; }
    if (msg === null || typeof msg !== 'object') return;
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      // server-initiated request: answer ping, decline the rest
      if (msg.method === 'ping') this._send(rpcResponse(msg.id, {}));
      else this._send(rpcError(msg.id, ErrorCode.METHOD_NOT_FOUND, 'gateway does not support this downstream request'));
      return;
    }
    if (typeof msg.method === 'string') {
      this._handleDownstreamNotification(msg.method);
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      } else {
        log.debug('downstream', `"${this.name}" response with unknown id ${JSON.stringify(msg.id)}; ignoring`);
      }
    }
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = ++this._idSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new DownstreamTimeout(`${this.name}.${method}`, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.lastUsed = Date.now();
      this._send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }).catch(reject);
    });
  }

  notify(method, params) {
    return this._send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  _send(msg) {
    const line = `${JSON.stringify(msg)}\n`;
    this._writeChain = this._writeChain.then(() => new Promise((resolve) => {
      try {
        this.proc.stdin.write(line, () => resolve());
      } catch (err) {
        resolve();
        log.debug('downstream', `"${this.name}" write failed: ${err.message}`);
      }
    }));
    return this._writeChain;
  }

  get inflight() { return this.pending.size; }

  kill() {
    if (this.state === 'closed' || !this.proc) return;
    this.state = 'closed';
    const { proc } = this;
    try { proc.stdin.end(); } catch { /* already closed */ }
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 3_000);
    killTimer.unref?.();
    proc.on('exit', () => clearTimeout(killTimer));
    try { proc.kill('SIGTERM'); } catch { /* gone */ }
  }
}

/** Incremental SSE frame parser (shared by HTTP downstream + legacy SSE). */
class SseParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buf = '';
    this.lastId = null;
  }
  push(chunk) {
    this.buf += chunk.toString('utf8');
    // SSE blocks end with a blank line: \n\n or \r\n\r\n (or \r\r for old Macs)
    let m;
    while ((m = this.buf.match(/\r\n\r\n|\n\n|\r\r/)) !== null) {
      const raw = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this._dispatch(raw);
    }
    if (this.buf.length > 1 * 1024 * 1024) this.buf = ''; // pathological server; drop
  }
  _dispatch(raw) {
    let event = 'message';
    const data = [];
    for (let line of raw.split('\n')) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') this.lastId = value;
    }
    if (data.length > 0) this.onEvent({ event, data: data.join('\n') });
  }
}

/** Downstream over Streamable HTTP (POST /mcp with JSON or SSE responses). */
class HttpDownstream extends BaseDownstream {
  constructor(name, spec, opts) {
    super(name, spec, opts);
    this.type = spec.type === 'legacy-sse' ? 'legacy-sse' : 'http';
    this.url = spec.url;
    this.sessionId = null;
    this._idSeq = 0;
    this._authHeaders = spec.headers || {};
  }

  _headers(extra = {}) {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.remoteProtocolVersion ? { 'mcp-protocol-version': this.remoteProtocolVersion } : {}),
      ...this._authHeaders,
      ...extra,
    };
  }

  async connect() {
    if (this.type === 'legacy-sse') {
      await this._openLegacyStream();
    }
    return super.connect();
  }

  // --- legacy SSE: GET /sse -> endpoint event -> POST messages ----------------
  async _openLegacyStream() {
    this._legacyAbort = new AbortController();
    const res = await fetch(this.url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', ...this._authHeaders },
      signal: this._legacyAbort.signal,
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
      throw new ToolCallError(`${this.url} did not open an SSE stream (HTTP ${res.status})`);
    }
    this._legacyMessageUrl = null;
    const endpointReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DownstreamTimeout(`${this.name} endpoint event`, this.initTimeoutMs)), this.initTimeoutMs);
      this._legacyEndpointResolve = (url) => { clearTimeout(timer); resolve(url); };
    });
    const parser = new SseParser(({ event, data }) => {
      if (event === 'endpoint' && !this._legacyMessageUrl) {
        this._legacyMessageUrl = new URL(data, this.url).toString();
        this._legacyEndpointResolve?.(this._legacyMessageUrl);
      } else {
        this._onStreamMessage(data);
      }
    });
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => parser.push(chunk));
    body.on('error', (err) => log.warn('downstream', `"${this.name}" SSE stream error: ${err.message}`));
    await endpointReady;
    this._legacyStream = body;
  }

  _onStreamMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg === null || typeof msg !== 'object') return;
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this._respondToServerRequest(msg);
      return;
    }
    if (typeof msg.method === 'string') { this._handleDownstreamNotification(msg.method); return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this._streamPending?.get(msg.id);
      if (entry) {
        this._streamPending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  }

  _respondToServerRequest(msg) {
    const reply = msg.method === 'ping'
      ? rpcResponse(msg.id, {})
      : rpcError(msg.id, ErrorCode.METHOD_NOT_FOUND, 'gateway does not support this downstream request');
    this._rawPost(reply).catch((err) => log.debug('downstream', `"${this.name}" server-request reply failed: ${err.message}`));
  }

  async _rawPost(message, timeoutMs = this.requestTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = this.type === 'legacy-sse' ? this._legacyMessageUrl : this.url;
      return await fetch(url, {
        method: 'POST',
        headers: this.type === 'legacy-sse'
          ? { 'content-type': 'application/json', ...this._authHeaders }
          : this._headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = ++this._idSeq;
    const message = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    this.lastUsed = Date.now();

    if (this.type === 'legacy-sse') {
      return this._legacyRequest(message, timeoutMs);
    }

    let res;
    try {
      res = await this._rawPost(message, timeoutMs);
    } catch (err) {
      if (err.name === 'AbortError') throw new DownstreamTimeout(`${this.name}.${method}`, timeoutMs);
      throw new ToolCallError(`HTTP transport error talking to "${this.name}": ${err.message}`);
    }
    const newSession = res.headers.get('mcp-session-id');
    if (newSession && method === 'initialize') this.sessionId = newSession;
    if (res.status === 404 && this.sessionId) {
      this.state = 'closed';
      throw new SessionExpired(this.name);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      throw new ToolCallError(`downstream "${this.name}" answered HTTP ${res.status} ${detail}`.trimEnd());
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      return this._consumeSseResponse(res, id, timeoutMs);
    }
    if (res.status === 202 || res.status === 204 || contentType === '') return null;
    const body = await res.json().catch(() => null);
    if (body === null || typeof body !== 'object') throw new ToolCallError(`downstream "${this.name}" returned an unparseable body`);
    return body;
  }

  /** Read an SSE response stream; resolve on the message matching `id`. */
  _consumeSseResponse(res, id, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const parser = new SseParser(({ event, data }) => {
        if (event !== 'message' && event !== 'endpoint') return;
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg !== null && typeof msg === 'object' && msg.id === id && (msg.result !== undefined || msg.error !== undefined)) {
          settled = true;
          clearTimeout(timer);
          resolve(msg);
          controller.abort(); // we have our answer; stop reading
        } else if (msg !== null && typeof msg === 'object') {
          if (typeof msg.method === 'string' && msg.id !== undefined) this._respondToServerRequest(msg);
          else if (typeof msg.method === 'string') this._handleDownstreamNotification(msg.method);
        }
      });
      const controller = new AbortController();
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new DownstreamTimeout(`${this.name} response`, timeoutMs)); }
        controller.abort();
      }, timeoutMs);
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => parser.push(chunk));
      body.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new ToolCallError(`SSE stream error from "${this.name}": ${err.message}`)); }
      });
      body.on('end', () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new ToolCallError(`downstream "${this.name}" closed the stream without answering id ${id}`)); }
      });
    });
  }

  async _legacyRequest(message, timeoutMs) {
    this._streamPending = this._streamPending || new Map();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._streamPending.delete(message.id)) reject(new DownstreamTimeout(`${this.name}.${message.method}`, timeoutMs));
      }, timeoutMs);
      this._streamPending.set(message.id, { resolve, reject, timer });
      this._rawPost(message, timeoutMs).then(async (res) => {
        if (!res.ok) {
          if (this._streamPending.delete(message.id)) {
            clearTimeout(timer);
            reject(new ToolCallError(`downstream "${this.name}" answered HTTP ${res.status}`));
          }
        }
        // responses arrive on the GET stream; drain POST body to release the socket
        await res.arrayBuffer().catch(() => {});
      }).catch((err) => {
        if (this._streamPending.delete(message.id)) {
          clearTimeout(timer);
          reject(err.name === 'AbortError' ? new DownstreamTimeout(`${this.name}.${message.method}`, timeoutMs) : err);
        }
      });
    });
  }

  async notify(method, params) {
    const message = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    try {
      const res = await this._rawPost(message, this.initTimeoutMs);
      await res.arrayBuffer().catch(() => {});
    } catch (err) {
      log.debug('downstream', `"${this.name}" notify ${method} failed: ${err.message}`);
    }
  }

  get inflight() { return (this._streamPending?.size || 0) + (this._inflightPosts || 0); }

  kill() {
    this.state = 'closed';
    try { this._legacyAbort?.abort(); } catch { /* ignore */ }
    for (const [, entry] of this._streamPending || []) {
      clearTimeout(entry.timer);
      entry.reject(new ExitDuringCall(this.name));
    }
    this._streamPending?.clear();
  }
}

function createDownstream(spec, opts) {
  return spec.type === 'stdio'
    ? new StdioDownstream(spec.name, spec, opts)
    : new HttpDownstream(spec.name, spec, opts);
}

// ---------------------------------------------------------------------------
// [06] downstream manager — the lazy-loading heart of the gateway
// ---------------------------------------------------------------------------

class DownstreamManager {
  constructor({ servers = {}, defaults = {}, cacheDir, useCache = true } = {}) {
    this.servers = servers;
    this.defaults = defaults;
    this.connections = new Map();
    this.pendingConnects = new Map();
    this.catalog = new Map();
    this.useCache = useCache;
    this.cache = new CatalogCache(cacheDir ?? SETTINGS().cacheDir);
    if (!useCache) this.cache.disabled = true;
    this._cacheLoaded = false;
    this.startedAt = Date.now();
    this.stats = { connects: 0, reaps: 0, calls: 0, callErrors: 0, catalogRefreshes: 0 };
    this._idleTimer = setInterval(() => this._sweepIdle(), 5_000);
    this._idleTimer.unref?.();
  }

  serverNames() { return Object.keys(this.servers); }

  /** Fingerprint of a server spec — cache entries keyed to it invalidate on config change. */
  _fingerprint(name) {
    const spec = this.servers[name];
    if (!spec) return 'none';
    return createHash('sha256').update(JSON.stringify({
      type: spec.type, command: spec.command, args: spec.args, url: spec.url, cwd: spec.cwd,
      env: spec.env, headers: spec.headers,
    })).digest('hex').slice(0, 16);
  }

  _loadCacheOnce() {
    if (this._cacheLoaded) return;
    this._cacheLoaded = true;
    if (!this.useCache) return;
    const cached = this.cache.load();
    for (const [server, entry] of cached) {
      if (this.servers[server]) {
        this.catalog.set(server, { tools: entry.tools, fetchedAt: entry.fetchedAt, live: false, fingerprint: entry.fingerprint });
      }
    }
    if (cached.size > 0) log.info('catalog', `loaded cached catalog for ${cached.size} server(s) — discovery needs no connections`);
  }

  /**
   * The catalog (name+description+schema per downstream tool). Missing or stale
   * entries are fetched by connecting lazily; fresh entries survive restarts.
   * Stale = older than the catalog TTL, or the server spec changed since caching.
   */
  async getCatalog({ refresh = false } = {}) {
    this._loadCacheOnce();
    const ttl = intEnv('CONTEXT_SAVER_CATALOG_TTL_MS', 3_600_000, { min: 0 });
    const now = Date.now();
    const names = this.serverNames();
    const missing = refresh
      ? names
      : names.filter((n) => {
        const entry = this.catalog.get(n);
        if (!entry) return true;
        if (entry.fingerprint !== this._fingerprint(n)) return true;
        if (entry.live && now - entry.fetchedAt <= ttl) return false;
        if (!entry.live && now - entry.fetchedAt > ttl) return true;
        return now - entry.fetchedAt > ttl;
      });
    if (missing.length > 0) {
      await Promise.all(missing.map(async (name) => {
        try {
          const conn = await this.ensureConnected(name);
          const tools = await conn.listTools();
          this.catalog.set(name, { tools, fetchedAt: Date.now(), live: true, fingerprint: this._fingerprint(name) });
          this.stats.catalogRefreshes += 1;
          this.cache.save(this.catalog);
        } catch (err) {
          const prev = this.catalog.get(name);
          this.catalog.set(name, { tools: prev?.tools || [], fetchedAt: prev?.fetchedAt || 0, live: false, error: err.message, fingerprint: this._fingerprint(name) });
          log.warn('catalog', `cannot reach "${name}": ${err.message}`);
        }
      }));
    }
    return this.catalog;
  }

  /** Connect on demand — concurrent callers share one in-flight connect. */
  async ensureConnected(name) {
    const spec = this.servers[name];
    if (!spec) throw new ToolCallError(`unknown downstream server "${name}"`);
    const pending = this.pendingConnects.get(name);
    if (pending) return pending;
    const existing = this.connections.get(name);
    if (existing && existing.state === 'connected') {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing && (existing.state === 'closed')) {
      this.connections.delete(name);
    }
    const connect = (async () => {
      const initTimeoutMs = spec.initTimeoutMs ?? this.defaults.initTimeoutMs ?? 10_000;
      const requestTimeoutMs = spec.timeoutMs ?? this.defaults.timeoutMs ?? 60_000;
      const conn = createDownstream(spec, {
        initTimeoutMs,
        requestTimeoutMs,
        onNotification: (n) => this._onDownstreamEvent(name, n),
      });
      this.connections.set(name, conn);
      this.stats.connects += 1;
      try {
        await conn.connect();
        return conn;
      } catch (err) {
        this.connections.delete(name);
        try { conn.kill(); } catch { /* ignore */ }
        if (err instanceof DownstreamRpcError) throw err;
        throw new ToolCallError(`cannot connect to "${name}": ${err.message}`, {
          hint: `check "command"/"args" (or "url") for "${name}" in your config`,
        });
      }
    })();
    this.pendingConnects.set(name, connect);
    try {
      return await connect;
    } finally {
      this.pendingConnects.delete(name);
    }
  }

  _onDownstreamEvent(name, event) {
    if (event?.kind === 'catalog-refresh') {
      const entry = this.catalog.get(name);
      this.catalog.set(name, { tools: event.tools, fetchedAt: Date.now(), live: true });
      this.cache.save(this.catalog);
    }
  }

  async callTool(serverName, toolName, args) {
    const conn = await this.ensureConnected(serverName);
    const spec = this.servers[serverName];
    const timeoutMs = spec.timeoutMs ?? this.defaults.timeoutMs ?? 60_000;
    this.stats.calls += 1;
    conn.lastUsed = Date.now();
    try {
      return await conn.callTool(toolName, args, timeoutMs);
    } catch (err) {
      this.stats.callErrors += 1;
      throw mapDownstreamError(serverName, toolName, err);
    }
  }

  _sweepIdle() {
    const idleMs = SETTINGS().downstreamIdleMs;
    if (idleMs <= 0) return;
    const now = Date.now();
    for (const [name, conn] of this.connections) {
      const specIdle = this.servers[name]?.idleMs ?? this.defaults.idleMs ?? idleMs;
      if (conn.state === 'connected' && conn.inflight === 0 && now - conn.lastUsed > specIdle) {
        log.info('downstream', `reaping idle connection to "${name}" (unused for ${humanDuration(specIdle)})`);
        conn.kill();
        this.connections.delete(name);
        this.stats.reaps += 1;
      }
    }
  }

  connectionSnapshot() {
    return this.serverNames().map((name) => {
      const conn = this.connections.get(name);
      const spec = this.servers[name];
      return {
        name,
        type: spec.type,
        state: this.pendingConnects.has(name) ? 'connecting' : (conn ? conn.state : 'disconnected'),
        tools: this.catalog.get(name)?.tools.length ?? 0,
        pid: conn?.proc?.pid,
        endpoint: spec.url,
        lastUsed: conn ? humanDuration(Math.max(0, Date.now() - conn.lastUsed)) : 'never',
        error: this.catalog.get(name)?.error,
      };
    });
  }

  shutdown() {
    clearInterval(this._idleTimer);
    for (const [, conn] of this.connections) {
      try { conn.kill(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}

function mapDownstreamError(server, tool, err) {
  if (err instanceof DownstreamRpcError) {
    if (err.code === ErrorCode.INVALID_PARAMS) return err; // propagate as a protocol error
    return new ToolCallError(`${server}.${tool} failed: ${err.message}`, { code: err.code });
  }
  if (err.name === 'DownstreamTimeout') {
    return new ToolCallError(`${server}.${tool} timed out`, { hint: 'raise "timeoutMs" for this server in your config' });
  }
  if (err.name === 'ExitDuringCall') {
    return new ToolCallError(`${server} exited during the call`, { hint: 'it restarts automatically on the next call' });
  }
  if (err.name === 'SessionExpired') {
    return new ToolCallError(`session with ${server} expired`, { hint: 'the gateway reconnects automatically on the next call' });
  }
  if (err instanceof ToolCallError) return err;
  return new ToolCallError(`${server}.${tool} failed: ${err.message}`);
}

// ---------------------------------------------------------------------------
// [07] planner — deterministic task -> toolset scoring (no LLM, no network)
// ---------------------------------------------------------------------------

function scoreTools(task, catalog) {
  const taskTokens = tokenize(task);
  if (taskTokens.length === 0) return [];
  const results = [];
  for (const [server, entry] of catalog) {
    for (const def of entry.tools || []) {
      const nameTokens = tokenize(def.name);
      const descTokens = tokenize(def.description);
      const serverTokens = tokenize(server);
      let score = 0;
      const reasons = [];
      for (const t of taskTokens) {
        if (nameTokens.includes(t)) { score += 3; reasons.push(`"${t}" in name`); }
        else if (nameTokens.some((n) => (n.startsWith(t) || t.startsWith(n)) && Math.min(n.length, t.length) >= 3)) {
          score += 2; reasons.push(`"${t}" ~ name`);
        } else if (descTokens.includes(t)) { score += 1; reasons.push(`"${t}" in description`); }
      }
      for (const t of taskTokens) {
        if (serverTokens.includes(t)) { score += 1; reasons.push(`"${t}" in server name`); }
      }
      if (score > 0) {
        results.push({ server, def, score, reasons: [...new Set(reasons)].slice(0, 4) });
      }
    }
  }
  results.sort((a, b) => b.score - a.score || `${a.server}.${a.def.name}`.localeCompare(`${b.server}.${b.def.name}`));
  return results;
}

// ---------------------------------------------------------------------------
// [08] session + gateway engine + meta-tools
// ---------------------------------------------------------------------------

const META_TOOLS = [
  {
    name: 'cs_discover',
    title: 'Discover downstream tools',
    description: 'List or search every tool available through the gateway across all configured downstream MCP servers. Returns id, source server and a one-line description — no schemas, minimal tokens. Always do this before cs_load.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring matched against tool id, description and server name' },
        refresh: { type: 'boolean', description: 'Re-connect to downstream servers and refresh the catalog cache' },
      },
    },
  },
  {
    name: 'cs_plan',
    title: 'Plan the minimal toolset for a task',
    description: 'Inspect the user\'s task and recommend the minimal set of downstream tools to load. Scores the task against the whole catalog and returns ranked matches with reasons. Use when unsure which tools a task needs.',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: { task: { type: 'string', description: 'The user\'s task, verbatim' } },
    },
  },
  {
    name: 'cs_load',
    title: 'Lazy-load downstream tools',
    description: 'Load specific downstream tools into this session: their full input schemas are returned here and the tools become directly callable (the client also receives tools/list_changed). Accepts exact ids ("server__tool"), globs ("github:*") or bare tool names.',
    inputSchema: {
      type: 'object',
      required: ['tools'],
      properties: { tools: { type: 'array', items: { type: 'string' }, description: 'Tool ids or glob patterns to load' } },
    },
  },
  {
    name: 'cs_unload',
    title: 'Unload tools to reclaim context',
    description: 'Unload previously loaded downstream tools. Omit "tools" to unload everything loaded this session.',
    inputSchema: {
      type: 'object',
      properties: { tools: { type: 'array', items: { type: 'string' }, description: 'Loaded tool ids (or glob patterns) to unload; omit for all' } },
    },
  },
  {
    name: 'cs_call',
    title: 'Invoke a tool without loading it',
    description: 'Invoke any catalog tool by id right now, without loading its schema into the session (arguments pass through verbatim). Prefer cs_load when you need the input schema; use cs_call for one-off calls.',
    inputSchema: {
      type: 'object',
      required: ['tool'],
      properties: {
        tool: { type: 'string', description: 'Tool id ("server__tool")' },
        args: { type: 'object', description: 'Arguments object forwarded to the tool' },
      },
    },
  },
  {
    name: 'cs_status',
    title: 'Gateway status & token accounting',
    description: 'Show downstream servers and connection states, loaded tools, and live token-savings accounting for this session (context used vs. direct connections).',
    inputSchema: {
      type: 'object',
      properties: { verbose: { type: 'boolean', description: 'Include the full catalog with token estimates' } },
    },
  },
];
const META_TOOL_NAMES = new Set(META_TOOLS.map((t) => t.name));

const textResult = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra });

function oneLine(s, max = 92) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function invalidParams(message) {
  return Object.assign(new Error(message), { rpcCode: ErrorCode.INVALID_PARAMS });
}

function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function suggestIds(pattern, catalog, limit = 3) {
  const ids = [];
  for (const [server, entry] of catalog) {
    for (const d of entry.tools) ids.push(`${server}__${d.name}`);
  }
  const p = pattern.toLowerCase();
  const contains = ids.filter((id) => id.toLowerCase().includes(p)).slice(0, limit);
  if (contains.length > 0) return contains;
  return ids
    .map((id) => ({ id, d: editDistance(p, id.toLowerCase(), 3) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.id);
}

/** Resolve cs_load patterns ("srv:glob", "server__tool", "tool", "tool*") against the catalog. */
function resolvePatterns(patterns, catalog) {
  const matches = [];
  const misses = [];
  const seen = new Set();
  for (const pattern of patterns) {
    const found = [];
    let badServer = false;
    if (pattern.includes(':')) {
      const idx = pattern.indexOf(':');
      const srvPat = pattern.slice(0, idx);
      const rest = pattern.slice(idx + 1) || '*';
      for (const [server, entry] of catalog) {
        if (matchGlob(srvPat, server)) {
          for (const d of entry.tools) if (matchGlob(rest, d.name)) found.push({ server, def: d });
        }
      }
      badServer = ![...catalog.keys()].some((s) => matchGlob(srvPat, s));
    } else {
      for (const [server, entry] of catalog) {
        const exact = entry.tools.find((d) => `${server}__${d.name}` === pattern);
        if (exact) { found.push({ server, def: exact }); continue; }
        for (const d of entry.tools) if (matchGlob(pattern, d.name)) found.push({ server, def: d });
      }
    }
    if (found.length === 0) {
      misses.push({
        pattern,
        hint: badServer
          ? `no configured server matches "${pattern.split(':')[0]}"`
          : `did you mean: ${suggestIds(pattern, catalog).join(', ') || '(nothing similar)'}`,
      });
      continue;
    }
    for (const f of found) {
      const key = `${f.server}__${f.def.name}`;
      if (!seen.has(key)) { seen.add(key); matches.push({ server: f.server, def: f.def, key }); }
    }
  }
  return { matches, misses };
}

/** One client connection's worth of state. */
class GatewaySession {
  constructor(id) {
    this.id = id;
    this.createdAt = Date.now();
    this.lastSeen = Date.now();
    this.loaded = new Map(); // exposed key -> {key, server, tool, def}
    this.pendingNotifications = [];
    this.sink = null; // set by transports that can push asynchronously
    this.cancelled = new Set();
    this.negotiatedVersion = null;
    this.initialized = false;
    this.clientInfo = null;
    this.stats = { callsOk: 0, callsErr: 0, resultTokens: 0 };
  }
  touch() { this.lastSeen = Date.now(); }
  notify(obj) {
    if (this.sink) {
      try { this.sink(obj); return; } catch { /* fall through to queue */ }
    }
    this.pendingNotifications.push(obj);
  }
  notifyToolsChanged() { this.notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }
  drainNotifications() {
    const n = this.pendingNotifications;
    this.pendingNotifications = [];
    return n;
  }
  destroy() { this.sink = null; this.pendingNotifications = []; }
}

class GatewayEngine {
  constructor({ manager, configPath } = {}) {
    this.manager = manager || new DownstreamManager({});
    this.configPath = configPath || null;
    this.sessions = new Map();
    this.startedAt = Date.now();
  }

  createSession(id = randomUUID()) {
    const session = new GatewaySession(id);
    this.sessions.set(id, session);
    return session;
  }
  getSession(id) { return this.sessions.get(id); }
  deleteSession(id) {
    const s = this.sessions.get(id);
    if (s) s.destroy();
    return this.sessions.delete(id);
  }

  async handleRequest(msg, session) {
    session.touch();
    // A cancellation can only legitimately target a request that is already in
    // flight. Clearing any stale entry here prevents a LATE cancellation (one that
    // arrived after the previous reply was written) from suppressing the reply of
    // a future request that reuses the same id.
    session.cancelled.delete(msg.id);
    let reply;
    try {
      switch (msg.method) {
        case 'initialize': reply = rpcResponse(msg.id, this._initialize(msg, session)); break;
        case 'ping': reply = rpcResponse(msg.id, {}); break;
        case 'tools/list': reply = rpcResponse(msg.id, await this._toolsList(msg, session)); break;
        case 'tools/call': reply = rpcResponse(msg.id, await this._toolsCall(msg, session)); break;
        case 'resources/list': reply = rpcResponse(msg.id, { resources: [] }); break;
        case 'resources/templates/list': reply = rpcResponse(msg.id, { resourceTemplates: [] }); break;
        case 'prompts/list': reply = rpcResponse(msg.id, { prompts: [] }); break;
        default:
          reply = rpcError(msg.id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      if (err.rpcCode === ErrorCode.INVALID_PARAMS || (err instanceof DownstreamRpcError && err.code === ErrorCode.INVALID_PARAMS)) {
        reply = rpcError(msg.id, ErrorCode.INVALID_PARAMS, err.message, err instanceof DownstreamRpcError ? err.data : undefined);
      } else if (err instanceof ConfigError) {
        reply = rpcError(msg.id, ErrorCode.SERVER_ERROR, err.message);
      } else {
        log.error('engine', `error handling ${msg.method}: ${err.stack || err.message}`);
        reply = rpcError(msg.id, ErrorCode.INTERNAL_ERROR, `internal error: ${err.message}`);
      }
    }
    return { reply, notifications: session.drainNotifications() };
  }

  handleNotification(msg, session) {
    session.touch();
    if (msg.method === 'notifications/initialized') {
      log.info('session', `client ${session.clientInfo?.name || session.id} confirmed initialization`);
    } else if (msg.method === 'notifications/cancelled') {
      const rid = msg.params?.requestId;
      if (rid !== undefined) {
        if (session.cancelled.size > 1_000) {
          log.warn('session', 'cancellation set exceeded 1000 entries; clearing');
          session.cancelled.clear();
        }
        session.cancelled.add(rid);
      }
      log.debug('session', `client cancelled request ${JSON.stringify(rid)}`);
    }
    // other notifications are informational; the spec says ignore unknown ones
  }

  _initialize(msg, session) {
    const requested = msg.params?.protocolVersion;
    const chosen = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    session.negotiatedVersion = chosen;
    session.initialized = true;
    session.clientInfo = msg.params?.clientInfo || null;
    log.info('session', `initialize from ${session.clientInfo?.name || 'unknown client'} ${session.clientInfo?.version || ''} (protocol ${requested || '?'} -> ${chosen})`);
    return {
      protocolVersion: chosen,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: SERVER_NAME, version: VERSION, title: SERVER_TITLE },
      instructions: INSTRUCTIONS,
    };
  }

  _loadedToolDef(entry) {
    const def = entry.def;
    return {
      name: entry.key,
      ...(def.title ? { title: def.title } : {}),
      description: `${def.description ? `${def.description} ` : ''}(via ${entry.server})`,
      inputSchema: def.inputSchema,
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
      ...(def.annotations ? { annotations: def.annotations } : {}),
    };
  }

  async _toolsList(msg, session) {
    const all = [
      ...META_TOOLS.map((t) => structuredClone(t)),
      ...[...session.loaded.values()].map((t) => this._loadedToolDef(t)),
    ];
    const pageSize = SETTINGS().pageSize;
    let offset = 0;
    const cursor = msg.params?.cursor;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string') throw invalidParams('"cursor" must be a string');
      try {
        const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        if (decoded === null || typeof decoded !== 'object' || !Number.isInteger(decoded.o) || decoded.o < 0) throw new Error('bad shape');
        offset = decoded.o;
      } catch {
        throw invalidParams('invalid pagination cursor');
      }
    }
    const page = all.slice(offset, offset + pageSize);
    const result = { tools: page };
    if (offset + pageSize < all.length) {
      result.nextCursor = Buffer.from(JSON.stringify({ o: offset + pageSize })).toString('base64url');
    }
    return result;
  }

  async _toolsCall(msg, session) {
    const name = msg.params?.name;
    if (typeof name !== 'string' || name === '') throw invalidParams('tools/call requires a tool "name"');
    const args = msg.params?.arguments ?? {};
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw invalidParams('"arguments" must be an object');
    }

    const meta = META_HANDLERS[name];
    if (meta) return meta(this, session, args);

    const loaded = session.loaded.get(name);
    if (loaded) return this._callDownstream(session, loaded.server, loaded.tool, args);

    throw invalidParams(`Tool ${name} not found — call cs_discover or cs_plan, then cs_load it (or use cs_call)`);
  }

  async _callDownstream(session, server, tool, args) {
    try {
      const result = await this.manager.callTool(server, tool, args);
      session.stats.callsOk += 1;
      session.stats.resultTokens += estimateTokens(result);
      return result;
    } catch (err) {
      session.stats.callsErr += 1;
      if (err instanceof DownstreamRpcError && err.code === ErrorCode.INVALID_PARAMS) throw err;
      const text = [err.message, err.hint ? `Hint: ${err.hint}` : null].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }], isError: true };
    }
  }

  /** Token accounting: what this session costs vs. wiring every server directly. */
  async tokenReport(session) {
    const catalog = await this.manager.getCatalog();
    let baseline = 0;
    let toolCount = 0;
    for (const [, entry] of catalog) {
      for (const def of entry.tools) baseline += estimateTokens(def);
      toolCount += entry.tools.length;
    }
    const meta = estimateTokens(META_TOOLS);
    let loaded = 0;
    for (const [, entry] of session.loaded) loaded += estimateTokens(entry.def) + 8;
    const sessionTotal = meta + loaded;
    const saved = baseline > 0 ? baseline - sessionTotal : 0;
    return {
      servers: catalog.size,
      tools: toolCount,
      baselineTokens: baseline,
      metaTokens: meta,
      loadedTokens: loaded,
      sessionTokens: sessionTotal,
      savedTokens: saved,
      savedPct: baseline > 0 ? Math.round((saved / baseline) * 1000) / 10 : 0,
      loadedCount: session.loaded.size,
    };
  }
}

// --- meta-tool implementations ----------------------------------------------

async function hDiscover(engine, session, args) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const refresh = args.refresh === true;
  const catalog = await engine.manager.getCatalog({ refresh });

  const servers = [...catalog.entries()].filter(([name]) => engine.manager.servers[name]);
  if (servers.length === 0 || engine.manager.serverNames().length === 0) {
    return textResult([
      'No downstream MCP servers are configured yet.',
      '',
      `Create a config file and point the gateway at it (default: ~/.context-saver/config.json or $CONTEXT_SAVER_CONFIG):`,
      '',
      '{"servers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}}}',
      '',
      'Restart the gateway, then cs_discover again. See the README for remote (HTTP) servers, headers and OAuth.',
    ].join('\n'));
  }

  let totalTools = 0;
  let totalTokens = 0;
  for (const [, entry] of servers) {
    totalTools += entry.tools.length;
    totalTokens += entry.tools.reduce((s, d) => s + estimateTokens(d), 0);
  }

  const lines = [`${totalTools} tool(s) across ${servers.length} server(s) · ≈${fmtTokens(totalTokens)} tok if loaded upfront`];
  if (servers.some(([, e]) => !e.live)) lines.push('(catalog from disk cache — cs_discover {"refresh":true} re-checks)');

  let shown = 0;
  for (const [server, entry] of servers) {
    const tools = query
      ? entry.tools.filter((d) => `${server}__${d.name} ${d.description || ''}`.toLowerCase().includes(query.toLowerCase()))
      : entry.tools;
    if (query && tools.length === 0) continue;
    const flags = [`${entry.tools.length} tool(s)`];
    if (entry.error) flags.push(`unreachable: ${oneLine(entry.error, 60)}`);
    lines.push('', `${server} — ${flags.join(' · ')}:`);
    for (const d of tools.slice(0, 60)) {
      lines.push(`  ${server}__${d.name} — ${oneLine(d.description) || '(no description)'} [≈${estimateTokens(d)} tok]`);
      shown += 1;
    }
    if (tools.length > 60) lines.push(`  … and ${tools.length - 60} more — narrow the query`);
  }
  if (query && shown === 0) {
    lines.push('', `No tool matches "${query}". Try a shorter query, or browse with cs_discover {}.`);
  }
  lines.push('', 'Next: cs_load {"tools":["<id>", …]} · cs_plan {"task":"…"} · cs_call {"tool":"<id>","args":{}}');
  return textResult(lines.join('\n'));
}

async function hPlan(engine, session, args) {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) throw invalidParams('cs_plan requires a non-empty "task"');
  const catalog = await engine.manager.getCatalog();
  const scored = scoreTools(task, catalog);
  if (engine.manager.serverNames().length === 0) {
    return textResult('No downstream MCP servers configured — see cs_discover output for setup help.');
  }
  if (scored.length === 0) {
    return textResult([
      `Task: "${task}"`,
      '',
      'No catalog tool scored above zero for this task.',
      'Browse everything with cs_discover {} — the right tool may use different wording than the task.',
    ].join('\n'));
  }
  const cutoff = Math.max(2, Math.ceil(scored[0].score / 3));
  const chosen = scored.filter((s) => s.score >= cutoff).slice(0, 6);
  const ids = chosen.map((s) => `${s.server}__${s.def.name}`);
  const estTokens = chosen.reduce((sum, s) => sum + estimateTokens(s.def), 0);
  const lines = [
    `Task: "${task}"`,
    '',
    `Recommended toolset — ${chosen.length} tool(s), ≈${fmtTokens(estTokens)} tok:`,
    ...chosen.map((s, i) => `  ${i + 1}. ${s.server}__${s.def.name} — ${s.reasons.join(', ')}`),
    '',
    `Load with: cs_load {"tools":${JSON.stringify(ids)}}`,
    'Browse everything: cs_discover {"query":"…"}',
  ];
  return textResult(lines.join('\n'), {
    structuredContent: {
      task,
      recommended: chosen.map((s) => ({
        id: `${s.server}__${s.def.name}`, server: s.server, tool: s.def.name,
        score: s.score, reasons: s.reasons, description: oneLine(s.def.description, 160),
      })),
    },
  });
}

function assignLoadedKey(session, server, tool) {
  const existing = [...session.loaded.values()].find((e) => e.server === server && e.tool === tool);
  if (existing) return existing.key;
  let base = sanitizeToolName(`${server}__${tool}`, 64);
  if (META_TOOL_NAMES.has(base) || base === 'ping') base = `${base}_2`;
  let key = base;
  let i = 2;
  while (session.loaded.has(key)) key = `${base}_${i++}`;
  return key;
}

async function hLoad(engine, session, args) {
  const patterns = args.tools;
  if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((p) => typeof p === 'string' && p !== '')) {
    throw invalidParams('cs_load requires "tools": a non-empty array of strings');
  }
  const catalog = await engine.manager.getCatalog();
  const { matches, misses } = resolvePatterns(patterns, catalog);

  // Fresh schemas straight from a live connection per owning server.
  const freshByServer = new Map();
  const loaded = [];
  const vanished = [];
  for (const m of matches) {
    let def = m.def;
    try {
      if (!freshByServer.has(m.server)) {
        const conn = await engine.manager.ensureConnected(m.server);
        freshByServer.set(m.server, conn.tools);
      }
      const fresh = freshByServer.get(m.server).find((d) => d.name === m.def.name);
      if (fresh) def = fresh;
      else vanished.push(`${m.server}__${m.def.name}`);
    } catch (err) {
      log.warn('load', `fresh schema fetch failed for ${m.server}: ${err.message} (using catalog copy)`);
    }
    const key = assignLoadedKey(session, m.server, def.name);
    const entry = { key, server: m.server, tool: def.name, def };
    session.loaded.set(key, entry);
    loaded.push(entry);
  }

  const report = await engine.tokenReport(session);
  session.notifyToolsChanged();

  const lines = [];
  if (loaded.length > 0) {
    lines.push(`Loaded ${loaded.length} tool(s) (+${fmtTokens(report.loadedTokens)} tok) — they are now callable directly.`);
    for (const e of loaded) {
      lines.push('', `# ${e.key} (via ${e.server})`);
      if (e.def.description) lines.push(e.def.description);
      lines.push(`inputSchema: ${JSON.stringify(e.def.inputSchema)}`);
    }
    lines.push('', [
      `Session context: meta ≈${fmtTokens(report.metaTokens)} + loaded ≈${fmtTokens(report.loadedTokens)} = ≈${fmtTokens(report.sessionTokens)} tok`,
      report.baselineTokens > 0
        ? `vs ≈${fmtTokens(report.baselineTokens)} tok with direct connections → saved ≈${fmtTokens(report.savedTokens)} tok (${report.savedPct}%)`
        : '',
    ].filter(Boolean).join(' '));
  } else {
    lines.push('Loaded nothing.');
  }
  for (const miss of misses) lines.push(`⚠ no match for "${miss.pattern}" — ${miss.hint}`);
  for (const v of vanished) lines.push(`⚠ ${v} vanished from its server since the catalog was cached — cs_discover {"refresh":true}`);

  return textResult(lines.join('\n'), {
    structuredContent: {
      loaded: loaded.map((e) => ({
        id: e.key, server: e.server, tool: e.tool,
        description: e.def.description || null, inputSchema: e.def.inputSchema,
      })),
      misses,
      tokens: report,
    },
  });
}

async function hUnload(engine, session, args) {
  let removed = [];
  if (args.tools === undefined) {
    removed = [...session.loaded.values()];
    session.loaded.clear();
  } else {
    if (!Array.isArray(args.tools) || !args.tools.every((p) => typeof p === 'string')) {
      throw invalidParams('cs_unload "tools" must be an array of strings (or omitted to unload all)');
    }
    for (const pattern of args.tools) {
      for (const [key, entry] of [...session.loaded]) {
        if (key === pattern || matchGlob(pattern, key) || matchGlob(pattern, entry.tool) || matchGlob(pattern, `${entry.server}:${entry.tool}`)) {
          session.loaded.delete(key);
          removed.push(entry);
        }
      }
    }
  }
  session.notifyToolsChanged();
  const report = await engine.tokenReport(session);
  const lines = [
    `Unloaded ${removed.length} tool(s) (−${fmtTokens(removed.reduce((s, e) => s + estimateTokens(e.def) + 8, 0))} tok).`,
    `${session.loaded.size} loaded tool(s) remain — session context ≈${fmtTokens(report.sessionTokens)} tok.`,
  ];
  return textResult(lines.join('\n'), { structuredContent: { unloaded: removed.map((e) => e.key), tokens: report } });
}

async function hStatus(engine, session, args) {
  const verbose = args.verbose === true;
  const catalog = await engine.manager.getCatalog();
  const report = await engine.tokenReport(session);
  const snap = engine.manager.connectionSnapshot();

  const lines = [];
  lines.push(`${SERVER_TITLE} v${VERSION} · uptime ${humanDuration(Date.now() - engine.startedAt)}`);
  lines.push(`config: ${engine.configPath || '(none — no downstream servers)'}`);
  lines.push('', 'Downstream servers:');
  if (snap.length === 0) lines.push('  (none configured)');
  for (const s of snap) {
    const where = s.pid ? `pid ${s.pid}` : (s.endpoint || '');
    lines.push(`  ${s.name.padEnd(14)} ${s.type.padEnd(10)} ${s.state.padEnd(12)} ${String(s.tools).padStart(3)} tool(s)  ${where}  used ${s.lastUsed} ago${s.error ? `  ⚠ ${oneLine(s.error, 50)}` : ''}`);
  }
  lines.push('', `Session ${session.id} (${session.clientInfo?.name || 'stdio'} · ${session.loaded.size} loaded / ${report.tools} catalog):`);
  for (const [key, e] of session.loaded) lines.push(`  ${key} (≈${estimateTokens(e.def)} tok)`);
  if (report.baselineTokens > 0) {
    lines.push('', `Context: meta ≈${fmtTokens(report.metaTokens)} + loaded ≈${fmtTokens(report.loadedTokens)} = ≈${fmtTokens(report.sessionTokens)} tok`);
    lines.push(`         direct connections would cost ≈${fmtTokens(report.baselineTokens)} tok → saved ≈${fmtTokens(report.savedTokens)} tok (${report.savedPct}%)`);
  }
  lines.push(`Calls: ${session.stats.callsOk} ok · ${session.stats.callsErr} error · ≈${fmtTokens(session.stats.resultTokens)} tok in results`);
  const m = engine.manager.stats;
  lines.push(`Gateway: ${m.connects} connects · ${m.reaps} idle reaps · ${m.calls} total calls · ${m.catalogRefreshes} catalog refreshes`);

  if (verbose) {
    lines.push('', 'Full catalog:');
    for (const [server, entry] of catalog) {
      lines.push(`  ${server}:`);
      for (const d of entry.tools) lines.push(`    ${server}__${d.name} [≈${estimateTokens(d)} tok] ${oneLine(d.description, 70)}`);
    }
  }

  return textResult(lines.join('\n'), {
    structuredContent: {
      version: VERSION, uptimeSec: Math.round((Date.now() - engine.startedAt) / 1000),
      config: engine.configPath, servers: snap, tokens: report,
      session: {
        id: session.id, loaded: [...session.loaded.keys()],
        callsOk: session.stats.callsOk, callsErr: session.stats.callsErr,
      },
      manager: engine.manager.stats,
    },
  });
}

async function hCall(engine, session, args) {
  const toolId = args.tool;
  if (typeof toolId !== 'string' || toolId === '') throw invalidParams('cs_call requires "tool": a tool id');
  const callArgs = args.args ?? {};
  if (callArgs === null || typeof callArgs !== 'object' || Array.isArray(callArgs)) {
    throw invalidParams('cs_call "args" must be an object');
  }

  const loaded = session.loaded.get(toolId);
  if (loaded) {
    return engine._callDownstream(session, loaded.server, loaded.tool, callArgs);
  }

  // Resolve against the catalog (exact id, then unique bare tool name).
  const catalog = await engine.manager.getCatalog();
  let server;
  let tool;
  const exact = [...catalog.entries()].find(([s, e]) => e.tools.some((d) => `${s}__${d.name}` === toolId));
  if (exact) {
    server = exact[0];
    tool = exact[1].tools.find((d) => `${exact[0]}__${d.name}` === toolId).name;
  } else {
    const bare = [...catalog.entries()].flatMap(([s, e]) => e.tools.map((d) => ({ server: s, tool: d.name })))
      .filter((x) => x.tool === toolId);
    if (bare.length === 1) ({ server, tool } = bare[0]);
    else if (bare.length > 1) {
      throw invalidParams(`"${toolId}" is ambiguous across servers: ${bare.map((b) => `${b.server}__${b.tool}`).join(', ')}`);
    }
  }
  if (!server) {
    // The server may be configured but unreachable (empty catalog) — try anyway so
    // the user sees the real connection error instead of "unknown tool".
    const parts = toolId.split('__');
    const fallbackServer = parts.length >= 2 ? engine.manager.servers[parts[0]] : null;
    const fallbackEntry = fallbackServer ? catalog.get(parts[0]) : null;
    if (fallbackServer && (!fallbackEntry || fallbackEntry.tools.length === 0)) {
      return engine._callDownstream(session, parts[0], parts.slice(1).join('__'), callArgs);
    }
    const hint = suggestIds(toolId, catalog).join(', ');
    throw invalidParams(`unknown tool "${toolId}"${hint ? ` — did you mean: ${hint}` : ''}`);
  }
  return engine._callDownstream(session, server, tool, callArgs);
}

const META_HANDLERS = {
  cs_discover: hDiscover,
  cs_plan: hPlan,
  cs_load: hLoad,
  cs_unload: hUnload,
  cs_status: hStatus,
  cs_call: hCall,
};

// ---------------------------------------------------------------------------
// [09] stdio transport
// ---------------------------------------------------------------------------

/** Serialize writes to a stream (JSON-RPC messages must not interleave). */
function serializeWrite(stream) {
  let chain = Promise.resolve();
  return (obj) => {
    chain = chain.then(() => new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        const ok = stream.write(`${JSON.stringify(obj)}\n`, done);
        if (ok === true) done();
      } catch {
        done();
      }
    })).catch(() => {});
    return chain;
  };
}

async function runStdioGateway({ engine, manager }) {
  const session = engine.createSession('stdio');
  const writeLine = serializeWrite(process.stdout);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { rl.close(); } catch { /* ignore */ }
    try { manager.shutdown(); } catch { /* ignore */ }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  rl.on('line', async (line) => {
    if (shuttingDown || !line.trim()) return;
    if (line.length > STDIO_LINE_LIMIT) {
      writeLine(rpcError(null, ErrorCode.PARSE_ERROR, `Parse error: line exceeds ${STDIO_LINE_LIMIT} bytes`));
      return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      writeLine(rpcError(null, ErrorCode.PARSE_ERROR, 'Parse error: Invalid JSON'));
      return;
    }
    try {
      if (isJsonRpcRequest(msg)) {
        const { reply, notifications } = await engine.handleRequest(msg, session);
        const wasCancelled = session.cancelled.delete(msg.id);
        if (!wasCancelled) writeLine(reply);
        else log.debug('session', `skipping reply to cancelled request ${JSON.stringify(msg.id)}`);
        for (const n of notifications) writeLine(n);
      } else if (isJsonRpcNotification(msg)) {
        engine.handleNotification(msg, session);
        for (const n of session.drainNotifications()) writeLine(n);
      } else if (msg !== null && typeof msg === 'object' && (msg.result !== undefined || msg.error !== undefined)) {
        log.debug('session', 'client sent a response message over stdio; ignoring');
      } else {
        writeLine(rpcError(null, ErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC message'));
      }
    } catch (err) {
      log.error('stdio', `unhandled error: ${err.stack || err.message}`);
      if (msg && msg.id !== undefined) writeLine(rpcError(msg.id, ErrorCode.INTERNAL_ERROR, 'internal error'));
    }
  });
  rl.on('close', () => shutdown(0));
  process.stdin.on('error', () => shutdown(0));
  process.stdout.on('error', () => shutdown(0));

  log.info('gateway', `stdio gateway ready — ${manager.serverNames().length} downstream server(s) configured`);
}

// ---------------------------------------------------------------------------
// [10] HTTP transport — Streamable HTTP + legacy SSE + session sweep
// ---------------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      resolve(err ? { err } : { body: Buffer.concat(chunks) });
    };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.destroy();
        finish('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish());
    req.on('error', () => finish('aborted'));
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function openSse(res, { sessionId } = {}) {
  if (res.writableEnded || res.destroyed) return false;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  });
  return true;
}

function writeSseEvent(res, obj) {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
  } catch { /* client went away */ }
}

function writeSseComment(res, text) {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(`: ${text}\n\n`);
  } catch { /* client went away */ }
}

function isLoopbackHost(hostHeader) {
  try {
    const { hostname } = new URL(`http://${hostHeader}`);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true; // non-browser client
  let o;
  try { o = new URL(origin); } catch { return false; }
  const host = String(req.headers.host || '');
  if (o.host === host) return true; // same origin
  if (isLoopbackHost(host) && ['localhost', '127.0.0.1', '::1'].includes(o.hostname)) return true;
  const allowed = new Set([...allowedOrigins, ...allowedOrigins.map((a) => a.replace(/^https?:\/\//, ''))]);
  return allowed.has(o.host) || allowed.has(origin);
}

function createGatewayHttpServer({ engine, manager, auth = null, allowedOrigins = [], sessionTtlMs, keepAliveMs = SSE_KEEPALIVE_MS, getIssuerBase }) {
  const ttl = sessionTtlMs ?? SETTINGS().sessionTtlMs;

  const issuerBase = (req) => {
    if (getIssuerBase) return getIssuerBase(req);
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || `${DEFAULT_HTTP_HOST}:${DEFAULT_HTTP_PORT}`;
    return `${proto}://${host}`.replace(/\/$/, '');
  };

  const requireAuth = (req, res) => {
    if (!auth) return true;
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const token = m ? m[1].trim() : null;
    const verdict = token ? auth.verifyToken(token) : null;
    if (verdict) {
      req.auth = verdict;
      return true;
    }
    const base = issuerBase(req);
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"${token ? ', error="invalid_token"' : ''}`);
    sendJson(res, 401, rpcError(null, ErrorCode.SERVER_ERROR, token ? 'Invalid or expired access token' : 'Unauthorized: an OAuth access token is required'));
    return false;
  };

  const server = createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    route(req, res).catch((err) => {
      log.error('http', `${req.method} ${req.url} -> ${err.stack || err.message}`);
      sendJson(res, 500, rpcError(null, ErrorCode.INTERNAL_ERROR, 'internal error'));
    });
  });
  server.on('clientError', (err, socket) => {
    log.debug('http', `client error: ${err.message}`);
    try { socket.destroy(); } catch { /* ignore */ }
  });

  async function route(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'internal.invalid'}`);
    const pathname = decodeURIComponent(u.pathname);

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true, version: VERSION, server: SERVER_NAME,
        uptimeSec: Math.round((Date.now() - engine.startedAt) / 1000),
        servers: manager.serverNames(),
      });
    }

    // OAuth surface (also answers CORS preflights for its public endpoints)
    if (auth && auth.handles(pathname, req.method)) return auth.route(req, res, pathname, u, { issuerBase: issuerBase(req) });
    if ((pathname.startsWith('/.well-known/') || pathname === '/token' || pathname === '/register') && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
      });
      res.end();
      return;
    }

    if (pathname === '/mcp') return routeMcp(req, res);
    if (pathname === '/sse' && req.method === 'GET') return routeLegacySse(req, res);
    if (pathname === '/messages' && req.method === 'POST') return routeLegacyMessages(req, res, u);
    return sendJson(res, 404, { error: 'not found', hint: 'MCP endpoint is /mcp' });
  }

  async function routeMcp(req, res) {
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return sendJson(res, 405, rpcError(null, ErrorCode.SERVER_ERROR, 'Method not allowed.'));
    }
    if (!originAllowed(req, allowedOrigins)) {
      return sendJson(res, 403, rpcError(null, ErrorCode.SERVER_ERROR, `Invalid Origin header: ${req.headers.origin}`));
    }
    if (!requireAuth(req, res)) return;

    if (req.method === 'POST') {
      const accept = String(req.headers.accept || '');
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        return sendJson(res, 406, rpcError(null, ErrorCode.SERVER_ERROR, 'Not Acceptable: Client must accept both application/json and text/event-stream'));
      }
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        return sendJson(res, 415, rpcError(null, ErrorCode.SERVER_ERROR, 'Unsupported Media Type: Content-Type must be application/json'));
      }
      const declaredLength = Number(req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > HTTP_BODY_LIMIT) {
        return sendJson(res, 413, rpcError(null, ErrorCode.SERVER_ERROR, `Payload Too Large: Request body must not exceed ${HTTP_BODY_LIMIT} bytes`));
      }
      const { err: bodyErr, body } = await readBody(req, HTTP_BODY_LIMIT);
      if (bodyErr === 'too-large') {
        return sendJson(res, 413, rpcError(null, ErrorCode.SERVER_ERROR, `Payload Too Large: Request body must not exceed ${HTTP_BODY_LIMIT} bytes`));
      }
      if (bodyErr) return; // client aborted mid-body

      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch {
        return sendJson(res, 400, rpcError(null, ErrorCode.PARSE_ERROR, 'Parse error: Invalid JSON'));
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)
        || (typeof msg.method !== 'string' && msg.result === undefined && msg.error === undefined)) {
        return sendJson(res, 400, rpcError(null, ErrorCode.PARSE_ERROR, 'Parse error: Invalid JSON-RPC message'));
      }

      const isInit = isJsonRpcRequest(msg) && msg.method === 'initialize';
      let session;
      if (isInit) {
        session = engine.createSession();
      } else {
        const sid = req.headers['mcp-session-id'];
        if (sid === undefined) {
          return sendJson(res, 400, rpcError(msg.id, ErrorCode.SERVER_ERROR, 'Bad Request: Mcp-Session-Id header is required'));
        }
        session = engine.getSession(String(sid));
        if (!session) return sendJson(res, 404, rpcError(msg.id, ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      }

      const pvHeader = req.headers['mcp-protocol-version'];
      if (pvHeader !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(pvHeader))) {
        return sendJson(res, 400, rpcError(msg.id, ErrorCode.SERVER_ERROR,
          `Bad Request: Unsupported protocol version: ${pvHeader} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`));
      }

      if (isJsonRpcNotification(msg)) {
        engine.handleNotification(msg, session);
        if (session.sink) { for (const n of session.drainNotifications()) session.sink(n); }
        if (!res.writableEnded) { res.writeHead(202); res.end(); }
        return;
      }
      if (!isJsonRpcRequest(msg)) { // a response to a server-initiated request; nothing to do
        if (!res.writableEnded) { res.writeHead(202); res.end(); }
        return;
      }

      const { reply, notifications } = await engine.handleRequest(msg, session);
      const wasCancelled = session.cancelled.delete(msg.id);

      if (notifications.length > 0) {
        openSse(res, { sessionId: session.id });
        if (!wasCancelled) writeSseEvent(res, reply);
        for (const n of notifications) writeSseEvent(res, n);
        res.end();
      } else if (wasCancelled) {
        res.writeHead(202);
        res.end();
      } else {
        res.setHeader('mcp-session-id', session.id);
        sendJson(res, 200, reply);
      }
      return;
    }

    if (req.method === 'GET') {
      const accept = String(req.headers.accept || '');
      if (!accept.includes('text/event-stream')) {
        return sendJson(res, 406, rpcError(null, ErrorCode.SERVER_ERROR, 'Not Acceptable: Client must accept text/event-stream'));
      }
      const sid = req.headers['mcp-session-id'];
      if (sid === undefined) {
        return sendJson(res, 400, rpcError(null, ErrorCode.SERVER_ERROR, 'Bad Request: Mcp-Session-Id header is required'));
      }
      const session = engine.getSession(String(sid));
      if (!session) return sendJson(res, 404, rpcError(null, ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      if (session.getSseStream) {
        return sendJson(res, 409, rpcError(null, ErrorCode.SERVER_ERROR, 'Conflict: Only one SSE stream is allowed per session'));
      }
      if (!openSse(res, { sessionId: session.id })) return;
      const keep = setInterval(() => writeSseComment(res, 'keepalive'), keepAliveMs);
      session.getSseStream = res;
      session.sink = (obj) => writeSseEvent(res, obj);
      const close = () => {
        clearInterval(keep);
        if (session.sink) { session.sink = null; session.getSseStream = null; }
        try { res.end(); } catch { /* ignore */ }
      };
      req.once('close', close);
      for (const n of session.drainNotifications()) writeSseEvent(res, n);
      return;
    }

    // DELETE — terminate the session
    const sid = req.headers['mcp-session-id'];
    const session = sid ? engine.getSession(String(sid)) : null;
    if (!session) return sendJson(res, 404, rpcError(null, ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
    engine.deleteSession(String(sid));
    if (session.sink) {
      session.sink = null;
      try { session.getSseStream?.end(); } catch { /* ignore */ }
      session.getSseStream = null;
    }
    res.writeHead(200);
    res.end();
  }

  // --- legacy HTTP+SSE transport (2025-03-26 clients) ------------------------
  function routeLegacySse(req, res) {
    if (!originAllowed(req, allowedOrigins)) {
      return sendJson(res, 403, rpcError(null, ErrorCode.SERVER_ERROR, `Invalid Origin header: ${req.headers.origin}`));
    }
    if (!requireAuth(req, res)) return;
    const session = engine.createSession();
    if (!openSse(res)) return;
    try { res.write(`event: endpoint\ndata: /messages?sessionId=${session.id}\n\n`); } catch { return; }
    const keep = setInterval(() => writeSseComment(res, 'keepalive'), keepAliveMs);
    session.legacyRes = res;
    session.getSseStream = res; // unified cleanup: sweeper + DELETE close this too
    session.sink = (obj) => writeSseEvent(res, obj);
    const close = () => {
      clearInterval(keep);
      session.sink = null;
      session.legacyRes = null;
      session.getSseStream = null;
      engine.deleteSession(session.id);
      try { res.end(); } catch { /* ignore */ }
    };
    req.once('close', close);
    return;
  }

  async function routeLegacyMessages(req, res, u) {
    if (!originAllowed(req, allowedOrigins)) {
      return sendJson(res, 403, rpcError(null, ErrorCode.SERVER_ERROR, `Invalid Origin header: ${req.headers.origin}`));
    }
    if (!requireAuth(req, res)) return;
    const sid = u.searchParams.get('sessionId');
    const session = sid ? engine.getSession(sid) : null;
    if (!session || !session.legacyRes) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('SSE connection not established');
      return;
    }
    const { err: bodyErr, body } = await readBody(req, HTTP_BODY_LIMIT);
    if (bodyErr === 'too-large') return sendJson(res, 413, rpcError(null, ErrorCode.SERVER_ERROR, 'Payload too large'));
    if (bodyErr) return;
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Invalid message: body is not JSON');
      return;
    }

    if (isJsonRpcRequest(msg)) {
      const { reply, notifications } = await engine.handleRequest(msg, session);
      const wasCancelled = session.cancelled.delete(msg.id);
      if (!wasCancelled) writeSseEvent(session.legacyRes, reply);
      for (const n of notifications) writeSseEvent(session.legacyRes, n);
    } else if (isJsonRpcNotification(msg)) {
      engine.handleNotification(msg, session);
      for (const n of session.drainNotifications()) writeSseEvent(session.legacyRes, n);
    }
    res.writeHead(202, { 'content-type': 'text/plain' });
    res.end('Accepted');
  }

  // --- idle session sweep -----------------------------------------------------
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of engine.sessions) {
      if (id === 'stdio') continue;
      if (now - s.lastSeen > ttl) {
        log.info('session', `sweeping idle session ${id} (inactive ${humanDuration(now - s.lastSeen)})`);
        if (s.sink) {
          s.sink = null;
          try { s.getSseStream?.end(); } catch { /* ignore */ }
          s.getSseStream = null;
        }
        engine.deleteSession(id);
      }
    }
  }, Math.min(15_000, ttl));
  sweeper.unref?.();

  server.__shutdown = () => {
    clearInterval(sweeper);
    manager.shutdown();
  };
  return server;
}

// ---------------------------------------------------------------------------
// [11] OAuth 2.1 authorization server (embedded, RFC 7591 + PKCE S256)
// ---------------------------------------------------------------------------

const OAUTH_SCOPES = ['mcp'];

function approvalPageHtml({ clientName, base, scopes }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — Context-Saver</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;font:16px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:420px;width:calc(100% - 48px);box-shadow:0 8px 40px rgba(0,0,0,.45)}
  h1{font-size:18px;margin:0 0 4px;display:flex;gap:10px;align-items:center}
  .logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#3fb950,#58a6ff);display:inline-block;flex:none}
  p{margin:14px 0;color:#8b949e}
  b{color:#e6edf3}
  .scopes{margin:18px 0;padding:12px 16px;background:#0d1117;border:1px solid #30363d;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#79c0ff}
  .btns{display:flex;gap:12px;margin-top:22px}
  button{flex:1;padding:11px 0;border-radius:8px;border:1px solid #30363d;font-size:15px;font-weight:600;cursor:pointer}
  .approve{background:#238636;border-color:#2ea043;color:#fff}
  .approve:hover{background:#2ea043}
  .deny{background:transparent;color:#8b949e}
  .deny:hover{color:#e6edf3}
  footer{margin-top:18px;font-size:12px;color:#484f58;text-align:center}
</style></head>
<body><form class="card" method="post" action="${base}/authorize">
  <h1><span class="logo"></span>Context-Saver</h1>
  <p><b>${escapeHtml(clientName)}</b> wants to access this MCP gateway.</p>
  <div class="scopes">scope: ${escapeHtml(scopes)}<br>server: ${escapeHtml(base)}</div>
  <p style="font-size:13px">Approving grants a bearer token valid for this gateway's MCP endpoint. You can revoke by restarting the gateway.</p>
  __HIDDEN__
  <div class="btns">
    <button class="approve" type="submit" name="action" value="approve">Approve</button>
    <button class="deny" type="submit" name="action" value="deny">Deny</button>
  </div>
  <footer>Context-Saver v${VERSION} · OAuth 2.1 + PKCE</footer>
</form></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPageHtml(title, detail) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font:16px/1.5 ui-sans-serif,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px 32px;max-width:420px}h1{font-size:17px;color:#f85149;margin:0 0 8px}p{color:#8b949e;margin:0}</style>
</head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div></body></html>`;
}

class OAuthProvider {
  constructor({ tokenTtlMs, refreshTokenTtlMs } = {}) {
    const settings = SETTINGS();
    this.tokenTtlMs = tokenTtlMs ?? settings.tokenTtlMs;
    this.refreshTokenTtlMs = refreshTokenTtlMs ?? settings.refreshTokenTtlMs;
    this.clients = new Map(); // client_id -> {name, redirectUris[], secret?}
    this.codes = new Map(); // code -> {clientId, redirectUri, challenge, scope, expiresAt, consumed}
    this.tokens = new Map(); // access -> {clientId, scope, expiresAt}
    this.refreshTokens = new Map(); // refresh -> {clientId, scope, expiresAt}
    this._rate = new Map(); // ip -> {count, windowStart}
  }

  handles(pathname, method) {
    if (pathname === '/.well-known/oauth-protected-resource' && method === 'GET') return true;
    if (/^\/\.well-known\/oauth-protected-resource(\/.+)?$/.test(pathname) && method === 'GET') return true;
    if (pathname === '/.well-known/oauth-authorization-server' && method === 'GET') return true;
    if (/^\/\.well-known\/oauth-authorization-server(\/.+)?$/.test(pathname) && method === 'GET') return true;
    if (pathname === '/register' && method === 'POST') return true;
    if (pathname === '/authorize' && (method === 'GET' || method === 'POST')) return true;
    if (pathname === '/token' && method === 'POST') return true;
    return false;
  }

  verifyToken(token) {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return { clientId: entry.clientId, scope: entry.scope };
  }

  _rateLimited(req) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const win = this._rate.get(ip);
    if (!win || now - win.windowStart > 15 * 60_000) {
      this._rate.set(ip, { count: 1, windowStart: now });
      return false;
    }
    win.count += 1;
    return win.count > 50;
  }

  async route(req, res, pathname, u, { issuerBase: base }) {
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    };
    if (pathname === '/.well-known/oauth-protected-resource' || /^\/\.well-known\/oauth-protected-resource\//.test(pathname)) {
      return sendJson(res, 200, {
        resource: base,
        authorization_servers: [base],
        scopes_supported: OAUTH_SCOPES,
        resource_name: SERVER_TITLE,
      }, corsHeaders);
    }
    if (pathname === '/.well-known/oauth-authorization-server' || /^\/\.well-known\/oauth-authorization-server\//.test(pathname)) {
      return sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: OAUTH_SCOPES,
        authorization_response_iss_parameter_supported: true,
      }, corsHeaders);
    }
    if (pathname === '/register') return this._handleRegister(req, res, base, corsHeaders);
    if (pathname === '/authorize') return this._handleAuthorize(req, res, u, base);
    if (pathname === '/token') return this._handleToken(req, res, base, corsHeaders);
    return sendJson(res, 404, { error: 'not found' });
  }

  async _handleRegister(req, res, base, corsHeaders) {
    const { err, body } = await readBody(req, 64 * 1024);
    if (err) return sendJson(res, 400, { error: 'invalid_client_metadata' }, corsHeaders);
    let meta;
    try { meta = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'body must be JSON' }, corsHeaders); }
    if (meta === null || typeof meta !== 'object' || !Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
      return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array' }, corsHeaders);
    }
    for (const uri of meta.redirect_uris) {
      if (typeof uri !== 'string') return sendJson(res, 400, { error: 'invalid_redirect_uri' }, corsHeaders);
      let parsed;
      try { parsed = new URL(uri); } catch { return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: `unparseable redirect URI: ${uri}` }, corsHeaders); }
      const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect URIs must be https (or http on loopback)' }, corsHeaders);
      }
    }
    const authMethod = meta.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'none';
    const clientId = `cscl_${b64url(randomBytes(12))}`;
    const client = {
      name: typeof meta.client_name === 'string' && meta.client_name ? meta.client_name.slice(0, 80) : 'Unnamed MCP client',
      redirectUris: meta.redirect_uris,
      authMethod,
      createdAt: Date.now(),
    };
    if (authMethod === 'client_secret_post') client.secret = b64url(randomBytes(32));
    this.clients.set(clientId, client);
    log.info('oauth', `registered client "${client.name}" (${clientId}) — ${client.redirectUris.length} redirect URI(s)`);
    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      ...(client.secret ? { client_secret: client.secret, client_secret_expires_at: 0 } : {}),
    }, corsHeaders);
  }

  _validateAuthorize(params, base) {
    const clientId = params.client_id;
    const client = clientId ? this.clients.get(clientId) : null;
    if (!client) return { error: 'unknown_client', detail: `Unknown client_id ${clientId || '(missing)'}` };
    const redirectUri = params.redirect_uri;
    if (typeof redirectUri !== 'string' || !client.redirectUris.includes(redirectUri)) {
      return { error: 'bad_redirect', detail: 'redirect_uri does not match a registered redirect URI' };
    }
    if (params.response_type !== 'code') return { error: 'redirect', err: 'unsupported_response_type', client, redirectUri };
    if (typeof params.code_challenge !== 'string' || params.code_challenge.length < 20) {
      return { error: 'redirect', err: 'invalid_request', errDesc: 'PKCE code_challenge is required', client, redirectUri };
    }
    if (params.code_challenge_method !== undefined && params.code_challenge_method !== 'S256') {
      return { error: 'redirect', err: 'invalid_request', errDesc: 'only S256 code_challenge_method is supported', client, redirectUri };
    }
    return { client, redirectUri };
  }

  async _handleAuthorize(req, res, u, base) {
    if (req.method === 'GET') {
      const params = Object.fromEntries(u.searchParams.entries());
      const v = this._validateAuthorize(params, base);
      if (v.error === 'unknown_client' || v.error === 'bad_redirect') {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPageHtml('Authorization error', v.detail));
        return;
      }
      if (v.error === 'redirect') {
        const target = new URL(v.redirectUri);
        target.searchParams.set('error', v.err);
        if (v.errDesc) target.searchParams.set('error_description', v.errDesc);
        if (params.state) target.searchParams.set('state', params.state);
        res.writeHead(302, { location: target.toString() });
        res.end();
        return;
      }
      const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type']
        .filter((k) => params[k] !== undefined)
        .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`)
        .join('');
      const scope = params.scope || OAUTH_SCOPES.join(' ');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(approvalPageHtml({ clientName: v.client.name, base, scopes: scope }).replace('__HIDDEN__', hidden));
      return;
    }

    // POST — the decision
    const { err, body } = await readBody(req, 64 * 1024);
    if (err) { res.writeHead(400); res.end(); return; }
    const params = {};
    for (const pair of body.toString('utf8').split('&')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
      const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
      params[k] = v;
    }
    const v = this._validateAuthorize(params, base);
    const target = v.redirectUri ? new URL(v.redirectUri) : null;
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(errorPageHtml('Authorization error', v.detail || 'invalid request'));
      return;
    }
    if (params.action !== 'approve') {
      target.searchParams.set('error', 'access_denied');
      if (params.state) target.searchParams.set('state', params.state);
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    const code = `csc_${b64url(randomBytes(24))}`;
    this.codes.set(code, {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      challenge: params.code_challenge,
      scope: params.scope || OAUTH_SCOPES.join(' '),
      expiresAt: Date.now() + 5 * 60_000,
      consumed: false,
    });
    target.searchParams.set('code', code);
    target.searchParams.set('iss', base);
    if (params.state) target.searchParams.set('state', params.state);
    log.info('oauth', `issued authorization code to "${v.client.name}"`);
    res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
    res.end();
  }

  async _handleToken(req, res, base, corsHeaders) {
    if (this._rateLimited(req)) {
      return sendJson(res, 429, { error: 'slow_down', error_description: 'too many token requests; retry in 15 minutes' }, corsHeaders);
    }
    const { err, body } = await readBody(req, 256 * 1024);
    if (err) return sendJson(res, 400, { error: 'invalid_request' }, corsHeaders);
    const form = {};
    for (const pair of body.toString('utf8').split('&')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      form[decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '))] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    }
    const grantType = form.grant_type;

    if (grantType === 'authorization_code') {
      const entry = form.code ? this.codes.get(form.code) : null;
      const invalidGrant = (desc) => sendJson(res, 400, { error: 'invalid_grant', ...(desc ? { error_description: desc } : {}) }, corsHeaders);
      if (!entry || entry.consumed || Date.now() >= entry.expiresAt) return invalidGrant('code is unknown, consumed or expired');
      const client = this.clients.get(form.client_id);
      if (!client || form.client_id !== entry.clientId) return invalidGrant('client_id does not match the authorization request');
      if (client.authMethod === 'client_secret_post' && form.client_secret !== client.secret) {
        return sendJson(res, 401, { error: 'invalid_client' }, corsHeaders);
      }
      if (form.redirect_uri !== entry.redirectUri) return invalidGrant('redirect_uri does not match the authorization request');
      if (!verifyPkce(form.code_verifier, entry.challenge)) {
        return invalidGrant('PKCE verification failed (S256)');
      }
      entry.consumed = true;
      this.codes.delete(form.code);
      const tokens = this._issueTokens(form.client_id, entry.scope);
      log.info('oauth', `token issued to client "${client.name}" (expires in ${Math.round(this.tokenTtlMs / 1000)}s)`);
      return sendJson(res, 200, tokens, corsHeaders);
    }

    if (grantType === 'refresh_token') {
      const invalidGrant = (desc) => sendJson(res, 400, { error: 'invalid_grant', ...(desc ? { error_description: desc } : {}) }, corsHeaders);
      const entry = form.refresh_token ? this.refreshTokens.get(form.refresh_token) : null;
      if (!entry || Date.now() >= entry.expiresAt) return invalidGrant('refresh token is unknown or expired');
      const client = this.clients.get(form.client_id);
      if (!client || form.client_id !== entry.clientId) return invalidGrant('client_id does not match the token');
      if (client.authMethod === 'client_secret_post' && form.client_secret !== client.secret) {
        return sendJson(res, 401, { error: 'invalid_client' }, corsHeaders);
      }
      this.refreshTokens.delete(form.refresh_token); // rotation
      const tokens = this._issueTokens(form.client_id, entry.scope);
      log.info('oauth', 'refresh token rotated');
      return sendJson(res, 200, tokens, corsHeaders);
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' }, corsHeaders);
  }

  _issueTokens(clientId, scope) {
    const accessToken = `csat_${b64url(randomBytes(32))}`;
    const refreshToken = `csrt_${b64url(randomBytes(32))}`;
    this.tokens.set(accessToken, { clientId, scope, expiresAt: Date.now() + this.tokenTtlMs });
    this.refreshTokens.set(refreshToken, { clientId, scope, expiresAt: Date.now() + this.refreshTokenTtlMs });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.round(this.tokenTtlMs / 1000),
      refresh_token: refreshToken,
      scope: scope || OAUTH_SCOPES.join(' '),
    };
  }
}

// ---------------------------------------------------------------------------
// [12] built-in demo servers — zero-setup demo fleet & test fixtures
// ---------------------------------------------------------------------------

const DEMO_SERVER_NAMES = ['demo-fs', 'demo-calc', 'demo-chaos'];

function seedDemoFiles(root) {
  mkdirSync(path.join(root, 'notes'), { recursive: true });
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'README.txt'),
    'Context-Saver demo filesystem\n=============================\nThis tiny virtual FS is served by the built-in "demo-fs" MCP server.\nTry list_dir, read_file and write_file — everything is sandboxed to a temp dir.\n');
  writeFileSync(path.join(root, 'notes', 'todo.md'),
    '# TODO\n\n- [x] connect one gateway instead of ten servers\n- [x] lazy-load tool schemas\n- [ ] tell everyone on Reddit\n');
  writeFileSync(path.join(root, 'data', 'metrics.csv'),
    'week,requests,tokens_saved\n1,120,1824000\n2,340,5160000\n3,580,8792000\n');
}

function safeJoin(root, rel) {
  const resolved = path.resolve(root, String(rel || '.'));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function buildDemoTools(serverName) {
  if (serverName === 'demo-fs') {
    const root = mkdtempSync(path.join(tmpdir(), 'context-saver-demo-'));
    seedDemoFiles(root);
    return [
      {
        name: 'list_dir',
        description: 'List files and folders in the demo filesystem. Returns one line per entry with its type (dir/file) and size.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative path, defaults to the root' } } },
        handler: (args) => {
          const target = safeJoin(root, args.path);
          if (!target || !existsSync(target)) return { content: [{ type: 'text', text: `path not found: ${args.path || '.'}` }], isError: true };
          const entries = [];
          for (const name of readdirSync(target).sort((a, b) => a.localeCompare(b))) {
            const full = path.join(target, name);
            const st = statSync(full);
            entries.push({ name, type: st.isDirectory() ? 'dir' : 'file', size: st.size });
          }
          const text = entries.map((e) => `${e.type.padEnd(4)} ${String(e.size).padStart(7)}  ${e.name}`).join('\n') || '(empty)';
          return { content: [{ type: 'text', text }], structuredContent: { entries } };
        },
      },
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the demo filesystem.',
        inputSchema: {
          type: 'object', required: ['path'],
          properties: { path: { type: 'string', description: 'Relative file path, e.g. "notes/todo.md"' } },
        },
        handler: (args) => {
          const target = safeJoin(root, args.path);
          if (!target) return { content: [{ type: 'text', text: 'path escapes the demo root' }], isError: true };
          if (!existsSync(target) || !statSync(target).isFile()) {
            return { content: [{ type: 'text', text: `file not found: ${args.path}` }], isError: true };
          }
          const text = readFileSync(target, 'utf8');
          if (text.length > 64 * 1024) return { content: [{ type: 'text', text: 'file too large for the demo (64 KB cap)' }], isError: true };
          return { content: [{ type: 'text', text }] };
        },
      },
      {
        name: 'write_file',
        description: 'Write (or overwrite) a UTF-8 text file in the demo filesystem. Creates parent folders as needed.',
        inputSchema: {
          type: 'object', required: ['path', 'content'],
          properties: {
            path: { type: 'string', description: 'Relative file path' },
            content: { type: 'string', description: 'Full file contents' },
          },
        },
        handler: (args) => {
          if (typeof args.content !== 'string' || args.content.length > 64 * 1024) {
            return { content: [{ type: 'text', text: 'content must be a string of at most 64 KB' }], isError: true };
          }
          const target = safeJoin(root, args.path);
          if (!target) return { content: [{ type: 'text', text: 'path escapes the demo root' }], isError: true };
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, args.content, 'utf8');
          return { content: [{ type: 'text', text: `wrote ${args.content.length} bytes to ${args.path}` }] };
        },
      },
      {
        name: 'tree',
        description: 'Render a recursive tree of the demo filesystem up to a depth limit, with file sizes.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to start from (default: root)' },
            depth: { type: 'integer', description: 'Maximum recursion depth (default 3, max 8)' },
            show_hidden: { type: 'boolean', description: 'Include dotfiles (default false)' },
          },
        },
        handler: (args) => {
          const start = safeJoin(root, args.path);
          if (!start || !existsSync(start)) return { content: [{ type: 'text', text: `path not found: ${args.path || '.'}` }], isError: true };
          const depth = Math.min(8, Math.max(1, Number(args.depth ?? 3)));
          const lines = [];
          const walk = (dir, prefix, level) => {
            const names = readdirSync(dir).filter((n) => (args.show_hidden ? true : !n.startsWith('.'))).sort();
            for (const [i, name] of names.entries()) {
              const last = i === names.length - 1;
              const full = path.join(dir, name);
              const isDir = statSync(full).isDirectory();
              lines.push(`${prefix}${last ? '└── ' : '├── '}${name}${isDir ? '/' : ` (${statSync(full).size} B)`}`);
              if (isDir && level < depth) walk(full, `${prefix}${last ? '    ' : '│   '}`, level + 1);
            }
          };
          lines.push('.');
          walk(start, '', 1);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        },
      },
      {
        name: 'search_files',
        description: 'Search the demo filesystem for a substring or regex. Returns matching files with line numbers and the matching lines. Useful to locate content before reading a whole file.',
        inputSchema: {
          type: 'object', required: ['pattern'],
          properties: {
            pattern: { type: 'string', description: 'Substring or regular expression to look for' },
            is_regex: { type: 'boolean', description: 'Treat pattern as a JavaScript regular expression (default false — plain substring)' },
            case_sensitive: { type: 'boolean', description: 'Case-sensitive matching (default true)' },
            glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.md" or "notes/*"' },
            max_results: { type: 'integer', description: 'Stop after this many matches (default 50)' },
          },
        },
        handler: (args) => {
          const maxResults = Math.min(500, Math.max(1, Number(args.max_results ?? 50)));
          let matcher;
          try {
            matcher = args.is_regex
              ? new RegExp(args.pattern, args.case_sensitive === false ? 'i' : '')
              : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.case_sensitive === false ? 'i' : '');
          } catch (err) {
            return { content: [{ type: 'text', text: `invalid pattern: ${err.message}` }], isError: true };
          }
          const glob = typeof args.glob === 'string' && args.glob.includes('*') ? args.glob : null;
          const results = [];
          const walk = (dir) => {
            if (results.length >= maxResults) return;
            for (const name of readdirSync(dir).sort()) {
              const full = path.join(dir, name);
              const st = statSync(full);
              if (st.isDirectory()) { walk(full); continue; }
              const rel = path.relative(root, full).split(path.sep).join('/');
              if (glob && !matchGlob(glob, rel)) continue;
              const text = readFileSync(full, 'utf8');
              for (const [idx, line] of text.split('\n').entries()) {
                if (matcher.test(line)) {
                  results.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 120)}`);
                  if (results.length >= maxResults) return;
                }
              }
            }
          };
          walk(root);
          return { content: [{ type: 'text', text: results.join('\n') || '(no matches)' }], structuredContent: { matches: results.length } };
        },
      },
    ];
  }

  if (serverName === 'demo-calc') {
    return [
      {
        name: 'add',
        title: 'Add two numbers',
        description: 'Add two numbers and return the sum.',
        inputSchema: {
          type: 'object', required: ['a', 'b'],
          properties: { a: { type: 'number', description: 'First addend' }, b: { type: 'number', description: 'Second addend' } },
        },
        handler: (args) => {
          const sum = Number(args.a) + Number(args.b);
          return { content: [{ type: 'text', text: String(sum) }], structuredContent: { result: sum } };
        },
      },
      {
        name: 'multiply',
        description: 'Multiply two numbers and return the product.',
        inputSchema: {
          type: 'object', required: ['a', 'b'],
          properties: { a: { type: 'number' }, b: { type: 'number' } },
        },
        handler: (args) => {
          const product = Number(args.a) * Number(args.b);
          return { content: [{ type: 'text', text: String(product) }], structuredContent: { result: product } };
        },
      },
      {
        name: 'stats',
        description: 'Compute descriptive statistics (count, mean, median, min, max) over a list of numbers.',
        inputSchema: {
          type: 'object', required: ['numbers'],
          properties: { numbers: { type: 'array', items: { type: 'number' }, description: 'List of numbers' } },
        },
        handler: (args) => {
          const nums = Array.isArray(args.numbers) ? args.numbers.map(Number).filter(Number.isFinite) : [];
          if (nums.length === 0) return { content: [{ type: 'text', text: 'no finite numbers provided' }], isError: true };
          const sorted = [...nums].sort((x, y) => x - y);
          const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
          const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
          const out = { count: nums.length, mean, median, min: sorted[0], max: sorted[sorted.length - 1] };
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
        },
      },
      {
        name: 'now',
        description: 'Return the current date and time in UTC (ISO-8601).',
        inputSchema: { type: 'object', properties: {} },
        handler: () => ({ content: [{ type: 'text', text: new Date().toISOString() }] }),
      },
      {
        name: 'convert_units',
        title: 'Convert between units',
        description: 'Convert a value between length, mass, temperature and data units (metric and imperial).',
        inputSchema: {
          type: 'object', required: ['value', 'from', 'to'],
          properties: {
            value: { type: 'number', description: 'Magnitude to convert' },
            from: { type: 'string', enum: ['m', 'km', 'mi', 'ft', 'kg', 'lb', 'C', 'F', 'KB', 'MB', 'GB', 'tokens'], description: 'Source unit' },
            to: { type: 'string', enum: ['m', 'km', 'mi', 'ft', 'kg', 'lb', 'C', 'F', 'KB', 'MB', 'GB', 'tokens'], description: 'Target unit' },
            precision: { type: 'integer', description: 'Decimal places in the result (default 4)' },
          },
        },
        handler: (args) => {
          const factors = { m: 1, km: 1000, mi: 1609.344, ft: 0.3048, kg: 1, lb: 0.45359237, KB: 1, MB: 1024, GB: 1048576, tokens: 4 };
          const family = (u) => (['m', 'km', 'mi', 'ft'].includes(u) ? 'len' : ['kg', 'lb'].includes(u) ? 'mass' : ['C', 'F'].includes(u) ? 'temp' : ['KB', 'MB', 'GB', 'tokens'].includes(u) ? 'data' : '?');
          const { value, from, to } = args;
          if (family(from) !== family(to) || family(from) === '?') {
            return { content: [{ type: 'text', text: `cannot convert ${from} -> ${to} (different unit families)` }], isError: true };
          }
          let out;
          if (from === 'C' && to === 'F') out = Number(value) * 9 / 5 + 32;
          else if (from === 'F' && to === 'C') out = (Number(value) - 32) * 5 / 9;
          else out = (Number(value) * factors[from]) / factors[to];
          const p = Math.min(10, Math.max(0, Number(args.precision ?? 4)));
          const result = Number(out.toFixed(p));
          return { content: [{ type: 'text', text: `${value} ${from} = ${result} ${to}` }], structuredContent: { result } };
        },
      },
      {
        name: 'format_report',
        title: 'Quarterly report formatter',
        description: 'Render a full quarterly business report with cover page, executive summary, per-quarter financials, headcount, a risk register and an appendix. Accepts richly structured input covering every section of the report; defaults exist for most fields but explicit values produce more accurate output. Use when the user asks to generate, format, export or summarize a quarterly or annual business report.',
        inputSchema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', description: 'Report title, printed on the cover page and every header' },
            subtitle: { type: 'string', description: 'Optional subtitle under the title' },
            author: { type: 'string', description: 'Author or team credited on the cover page' },
            department: { type: 'string', description: 'Owning department, e.g. "Engineering" or "Finance"' },
            date: { type: 'string', description: 'Report date (ISO-8601); defaults to today' },
            currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'JPY', 'CNY'], description: 'Currency used for all monetary figures' },
            quarters: {
              type: 'array',
              description: 'One entry per quarter covered by the report, in chronological order',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Quarter label such as "Q1 2026"' },
                  revenue: { type: 'number', description: 'Total revenue booked in the quarter' },
                  costs: { type: 'number', description: 'Total operating costs for the quarter' },
                  headcount: { type: 'integer', description: 'Average headcount during the quarter' },
                  notes: { type: 'string', description: 'Free-form commentary for the quarter' },
                },
              },
            },
            executive_summary: { type: 'string', description: 'One-paragraph executive summary; if omitted one is derived from the quarters' },
            risks: {
              type: 'array',
              description: 'Risk register entries, rendered as a table',
              items: {
                type: 'object',
                properties: {
                  severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Severity classification' },
                  area: { type: 'string', description: 'Affected area, e.g. "supply chain"' },
                  description: { type: 'string', description: 'What the risk is and why it matters' },
                  mitigation: { type: 'string', description: 'Planned or active mitigation' },
                },
              },
            },
            include_appendix: { type: 'boolean', description: 'Append an appendix with raw numbers (default true)' },
            footnote: { type: 'string', description: 'Footnote printed at the bottom of every page' },
          },
        },
        handler: (args) => {
          const q = Array.isArray(args.quarters) ? args.quarters : [];
          const lines = [
            '==============================================',
            `  ${String(args.title || 'Untitled report')}`,
            args.subtitle ? `  ${args.subtitle}` : '',
            `  ${args.department || ''} · ${args.author || 'Context-Saver demo'} · ${args.date || new Date().toISOString().slice(0, 10)}`,
            '==============================================',
            '',
            args.executive_summary || `Summary derived from ${q.length} quarter(s) of data.`,
            '',
            'Quarterly financials:',
            ...q.map((x) => `  ${x.label || '?'}: revenue ${x.revenue ?? '—'} ${args.currency || ''} · costs ${x.costs ?? '—'} · headcount ${x.headcount ?? '—'}`),
            '',
            'Risks:',
            ...(Array.isArray(args.risks) ? args.risks : []).map((r) => `  [${r.severity || '?'}] ${r.area || ''}: ${r.description || ''}`),
            '',
            args.include_appendix === false ? '' : 'Appendix: raw JSON input retained by the demo server.',
            args.footnote || '',
          ];
          return { content: [{ type: 'text', text: lines.filter((l) => l !== undefined).join('\n') }] };
        },
      },
      {
        name: 'format_table',
        title: 'Table formatter',
        description: 'Render structured rows as an aligned ASCII table, CSV, JSON or Markdown, with per-column alignment, widths, number formatting, optional sorting, grouping and a totals row. Use whenever the user wants tabular output, a comparison table, or to convert records between CSV/Markdown/JSON.',
        inputSchema: {
          type: 'object',
          required: ['columns', 'rows'],
          properties: {
            title: { type: 'string', description: 'Optional title line printed above the table' },
            columns: {
              type: 'array',
              description: 'Column definitions in display order',
              items: {
                type: 'object',
                required: ['key'],
                properties: {
                  key: { type: 'string', description: 'Field of each row object to display' },
                  header: { type: 'string', description: 'Header text; defaults to the key' },
                  align: { type: 'string', enum: ['left', 'right', 'center'], description: 'Cell alignment (default left; numbers default right)' },
                  width: { type: 'integer', description: 'Fixed column width; omitted = auto-fit to content' },
                  format: { type: 'string', description: 'Printf-style number format, e.g. "%.2f" or "%d"' },
                  hidden: { type: 'boolean', description: 'Omit this column from the output' },
                },
              },
            },
            rows: { type: 'array', description: 'Row objects; each key referenced by a column is rendered', items: { type: 'object' } },
            style: { type: 'string', enum: ['ascii', 'markdown', 'csv', 'json'], description: 'Output style (default ascii)' },
            delimiter: { type: 'string', description: 'CSV delimiter (default ",") when style is csv' },
            sort_by: { type: 'string', description: 'Column key to sort rows by before rendering' },
            sort_desc: { type: 'boolean', description: 'Sort descending (default false)' },
            group_by: { type: 'string', description: 'Column key to group rows by, inserting a subheader per group' },
            totals: { type: 'array', description: 'Column keys to append a numeric totals row for', items: { type: 'string' } },
          },
        },
        handler: (args) => {
          const columns = (Array.isArray(args.columns) ? args.columns : []).filter((c) => c && typeof c.key === 'string' && !c.hidden);
          let rows = Array.isArray(args.rows) ? args.rows.filter((r) => r && typeof r === 'object') : [];
          if (typeof args.sort_by === 'string') {
            rows = [...rows].sort((a, b) => {
              const av = a[args.sort_by]; const bv = b[args.sort_by];
              const cmp = (typeof av === 'number' && typeof bv === 'number') ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
              return args.sort_desc ? -cmp : cmp;
            });
          }
          const fmt = (v) => (v === undefined || v === null ? '' : String(v));
          const header = columns.map((c) => c.header || c.key);
          const dataRows = rows.map((r) => columns.map((c) => fmt(r[c.key])));
          if (Array.isArray(args.totals) && args.totals.length > 0) {
            const totalsRow = columns.map((c) => (args.totals.includes(c.key)
              ? String(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0))
              : ''));
            dataRows.push(totalsRow);
          }
          let out;
          if (args.style === 'json') {
            out = JSON.stringify(rows, null, 2);
          } else if (args.style === 'csv') {
            const d = args.delimiter || ',';
            out = [header.join(d), ...dataRows.map((r) => r.join(d))].join('\n');
          } else if (args.style === 'markdown') {
            out = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...dataRows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
          } else {
            const widths = header.map((h, i) => Math.max(h.length, ...dataRows.map((r) => r[i].length)));
            const line = (l, m, rr) => l + widths.map((w) => m + w + m).join(rr) + l;
            const row = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
            out = [line('+', '-', '+'), row(header), line('+', '-', '+'), ...dataRows.map(row), line('+', '-', '+')].join('\n');
          }
          const title = typeof args.title === 'string' && args.title ? `${args.title}\n\n` : '';
          return { content: [{ type: 'text', text: title + out }], structuredContent: { rows: rows.length, columns: columns.length, style: args.style || 'ascii' } };
        },
      },
    ];
  }

  if (serverName === 'demo-chaos') {
    return [
      {
        name: 'echo',
        description: 'Echo a message back. The dependable citizen of the chaos fleet.',
        inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string', description: 'Text to echo' } } },
        handler: (args) => ({
          content: [{ type: 'text', text: String(args.message ?? '') }],
          structuredContent: { message: String(args.message ?? '') },
        }),
      },
      {
        name: 'fail',
        description: 'Fail on demand: mode "error" returns a tool error result, "rpc" returns a JSON-RPC invalid-params error, "crash" kills the server process (the gateway auto-restarts it on the next call).',
        inputSchema: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['error', 'rpc', 'crash'], description: 'Failure mode (default "error")' } },
        },
        handler: (args) => {
          const mode = args.mode || 'error';
          if (mode === 'error') {
            return { content: [{ type: 'text', text: 'chaos: requested failure (isError result)' }], isError: true };
          }
          if (mode === 'crash') {
            setTimeout(() => process.exit(1), 30);
            return new Promise(() => {}); // never resolves — we exit first
          }
          throw Object.assign(new Error('chaos: invalid params (requested)'), { rpcCode: ErrorCode.INVALID_PARAMS });
        },
      },
      {
        name: 'slow',
        description: 'Sleep for the requested seconds before answering (for timeout/reconnect testing).',
        inputSchema: {
          type: 'object',
          properties: { seconds: { type: 'number', description: 'How long to sleep (default 1, max 30)' } },
        },
        handler: async (args) => {
          const s = Math.min(30, Math.max(0.01, Number(args.seconds ?? 1)));
          await new Promise((r) => setTimeout(r, s * 1000));
          return { content: [{ type: 'text', text: `slept ${s}s` }] };
        },
      },
      {
        name: 'weird name!',
        title: 'A tool with a non-conformant name',
        description: 'Deliberately named "weird name!" — invalid per the MCP naming regex — to prove the gateway sanitizes exposed names.',
        inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
        handler: () => ({ content: [{ type: 'text', text: 'sanitized-name round trip OK' }] }),
      },
    ];
  }
  return [];
}

// late import keeps the import block tidy; fs is already loaded below

/** Minimal spec-conformant stdio MCP server used for the demo fleet. */
async function runDemoServer(serverName) {
  const tools = buildDemoTools(serverName);
  const writeLine = serializeWrite(process.stdout);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!isJsonRpcRequest(msg)) return; // notifications ignored
    try {
      if (msg.method === 'initialize') {
        const requested = msg.params?.protocolVersion;
        writeLine(rpcResponse(msg.id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: VERSION, title: `${serverName} (Context-Saver demo)` },
        }));
      } else if (msg.method === 'ping') {
        writeLine(rpcResponse(msg.id, {}));
      } else if (msg.method === 'tools/list') {
        writeLine(rpcResponse(msg.id, {
          tools: tools.map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            ...(t.description ? { description: t.description } : {}),
            inputSchema: t.inputSchema,
          })),
        }));
      } else if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          writeLine(rpcError(msg.id, ErrorCode.INVALID_PARAMS, `Tool ${name} not found`));
          return;
        }
        try {
          const result = await tool.handler(msg.params?.arguments ?? {});
          if (result && result.rpcCode) throw result;
          writeLine(rpcResponse(msg.id, result));
        } catch (err) {
          if (err.rpcCode === ErrorCode.INVALID_PARAMS) {
            writeLine(rpcError(msg.id, err.rpcCode, err.message));
          } else {
            writeLine(rpcResponse(msg.id, { content: [{ type: 'text', text: `demo tool error: ${err.message}` }], isError: true }));
          }
        }
      } else {
        writeLine(rpcError(msg.id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${msg.method}`));
      }
    } catch (err) {
      writeLine(rpcError(msg.id, ErrorCode.INTERNAL_ERROR, String(err.message || err)));
    }
  });
  rl.on('close', () => process.exit(0));
  log.info('demo', `demo server "${serverName}" serving ${tools.length} tool(s)`);
}

function selfPath() {
  return realpathSync(fileURLToPath(import.meta.url));
}

function buildDemoConfigFile() {
  const me = selfPath();
  const config = {
    servers: {
      'demo-fs': { command: process.execPath, args: [me, '--demo-server', 'demo-fs'], description: 'built-in demo: sandboxed virtual filesystem' },
      'demo-calc': { command: process.execPath, args: [me, '--demo-server', 'demo-calc'], description: 'built-in demo: calculator + report formatter' },
      'demo-chaos': { command: process.execPath, args: [me, '--demo-server', 'demo-chaos'], description: 'built-in demo: failure injection' },
    },
  };
  const file = path.join(tmpdir(), `context-saver-demo-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// [13] interactive REPL client — try the gateway without Claude/Cursor
// ---------------------------------------------------------------------------

const ANSI = process.env.NO_COLOR
  ? { reset: '', dim: '', bold: '', cyan: '', green: '', yellow: '', magenta: '', red: '' }
  : { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m', red: '\x1b[31m' };
const paint = (color, s) => `${ANSI[color]}${s}${ANSI.reset}`;

/** Minimal MCP client used by the REPL, doctor and tests. */
class SimpleMcpClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this._idSeq = 0;
    this.onNotification = () => {};
    this._writeLine = serializeWrite(child.stdin);
    child.stdout.setEncoding('utf8');
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg === null || typeof msg !== 'object') return;
      if (typeof msg.method === 'string' && msg.id === undefined) {
        this.onNotification(msg);
        return;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg);
        } else if (this.onUnhandledMessage) {
          this.onUnhandledMessage(msg);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    const rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on('line', (line) => {
      if (process.env.CONTEXT_SAVER_CLIENT_DEBUG) process.stderr.write(`[gateway] ${line}\n`);
    });
  }
  static spawn(args, { env = {} } = {}) {
    const child = spawn(process.execPath, [selfPath(), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CONTEXT_SAVER_LOG: 'silent', ...env },
      windowsHide: true,
    });
    return new SimpleMcpClient(child);
  }
  request(method, params, timeoutMs = 30_000) {
    const id = ++this._idSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._writeLine({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }
  notify(method, params) {
    this._writeLine({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }
  async initialize(clientName = 'context-saver-client') {
    const res = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: VERSION },
    }, 10_000);
    if (res.error) throw new Error(`initialize failed: ${res.error.message}`);
    this.notify('notifications/initialized');
    return res.result;
  }
  close() {
    try { this.child.stdin.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000);
    t.unref?.();
    this.child.kill('SIGTERM');
  }
}

function printToolResult(result) {
  if (result === undefined || result === null) {
    console.log(paint('red', '(no result)'));
    return;
  }
  if (result.error) {
    console.log(paint('red', `JSON-RPC error ${result.error.code}: ${result.error.message}`));
    return;
  }
  const r = result.result || {};
  for (const block of r.content || []) {
    if (block.type === 'text') console.log(r.isError ? paint('red', block.text) : block.text);
    else console.log(paint('dim', `[${block.type} content]`));
  }
}

async function runReplClient(args = {}) {
  const configPath = args.demo ? buildDemoConfigFile() : (args.config || findConfigFile());
  if (!configPath) {
    console.error('No config found for --client. Pass --demo or --config <file>.');
    process.exit(1);
  }
  const client = SimpleMcpClient.spawn(args.demo ? ['--demo'] : ['--config', configPath]);
  const serverInfo = (await client.initialize('repl')).serverInfo;
  client.onNotification = (msg) => {
    if (msg.method === 'notifications/tools/list_changed') {
      console.log(paint('yellow', '\n[tools/list_changed] the loaded tool set changed — /tools to view'));
      process.stdout.write(paint('cyan', 'cs> '));
    }
  };

  console.log(paint('bold', `\n${SERVER_TITLE} v${VERSION} — interactive client`));
  console.log(paint('dim', `gateway: ${serverInfo.name} v${serverInfo.version} · config: ${configPath}`));
  console.log(paint('dim', 'commands: /discover [q] · /plan <task> · /load <ids…> · /unload · /call <id> <json> · /tools · /status · /quit'));
  console.log(paint('dim', 'plain text is treated as a task for /plan\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: paint('cyan', 'cs> '), terminal: true });
  rl.prompt();

  const call = async (method, params) => {
    const res = await client.request(method, params);
    printToolResult(res);
  };

  rl.on('line', async (line) => {
    const input = line.trim();
    try {
      if (!input) { /* no-op */ }
      else if (input === '/quit' || input === '/exit') { rl.close(); return; }
      else if (input === '/help') {
        console.log('/discover [query]   list/filter the tool catalog (no schemas)');
        console.log('/plan <task text>  recommend the minimal toolset for a task');
        console.log('/load <id> [id…]   lazy-load tools by id or glob (github:*)');
        console.log('/unload [id…]      unload tools (all if none given)');
        console.log('/call <id> <json>  call a tool directly, e.g. /call demo-calc__add {"a":2,"b":3}');
        console.log('/tools             show tools currently visible to this session');
        console.log('/status            servers, connections and token savings');
        console.log('/raw <json>        send a raw JSON-RPC message (debug)');
        console.log('/quit');
      } else if (input.startsWith('/discover')) {
        const query = input.slice('/discover'.length).trim();
        await call('tools/call', { name: 'cs_discover', arguments: query ? { query } : {} });
      } else if (input.startsWith('/plan ')) {
        await call('tools/call', { name: 'cs_plan', arguments: { task: input.slice(6).trim() } });
      } else if (input.startsWith('/load')) {
        const tools = input.slice(5).trim().split(/\s+/).filter(Boolean);
        await call('tools/call', { name: 'cs_load', arguments: { tools } });
      } else if (input.startsWith('/unload')) {
        const tools = input.slice(7).trim().split(/\s+/).filter(Boolean);
        await call('tools/call', { name: 'cs_unload', arguments: tools.length ? { tools } : {} });
      } else if (input.startsWith('/call ')) {
        const rest = input.slice(6).trim();
        const spaceIdx = rest.search(/\s/);
        const tool = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
        const rawArgs = spaceIdx === -1 ? '{}' : rest.slice(spaceIdx + 1).trim();
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(rawArgs); } catch {
          console.log(paint('yellow', `could not parse arguments as JSON: ${rawArgs}`));
          rl.prompt();
          return;
        }
        await call('tools/call', { name: 'cs_call', arguments: { tool, args: parsedArgs } });
      } else if (input === '/tools') {
        const res = await client.request('tools/list', {});
        const tools = res.result?.tools || [];
        const meta = tools.filter((t) => t.name.startsWith('cs_'));
        const loaded = tools.filter((t) => !t.name.startsWith('cs_'));
        console.log(paint('cyan', `${meta.length} meta-tools (always loaded):`));
        for (const t of meta) console.log(`  ${paint('dim', t.name)} — ${oneLine(t.description, 70)}`);
        console.log(paint('green', `${loaded.length} loaded tools:`));
        for (const t of loaded) console.log(`  ${paint('bold', t.name)} — ${oneLine(t.description, 70)}`);
      } else if (input === '/status') {
        await call('tools/call', { name: 'cs_status', arguments: {} });
      } else if (input.startsWith('/raw ')) {
        try {
          const msg = JSON.parse(input.slice(5));
          const res = await client.request(msg.method, msg.params);
          console.log(JSON.stringify(res, null, 2));
        } catch (err) {
          console.log(paint('red', `bad /raw message: ${err.message}`));
        }
      } else if (input.startsWith('/')) {
        console.log(paint('yellow', `unknown command "${input}" — /help for the list`));
      } else {
        await call('tools/call', { name: 'cs_plan', arguments: { task: input } });
      }
    } catch (err) {
      console.log(paint('red', `error: ${err.message}`));
    }
    rl.prompt();
  }).on('close', () => {
    client.close();
    console.log(paint('dim', '\nbye — context saved.'));
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// [14] doctor — end-to-end self-diagnostic (also used by CI smoke tests)
// ---------------------------------------------------------------------------

async function runDoctor({ configPath } = {}) {
  const started = Date.now();
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };

  await check('node runtime', async () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 18 || (major === 18 && minor < 17)) throw new Error(`Node ${process.versions.node} is too old; need >= 18.17`);
    return `Node ${process.versions.node}`;
  });

  let userConfigNote = '';
  await check('user config (advisory)', async () => {
    const found = findConfigFile(configPath);
    if (!found) return 'no config found (running demo self-test)';
    const cfg = loadConfig(configPath);
    userConfigNote = found;
    return `${found} — ${Object.keys(cfg.servers).length} server(s)`;
  });

  const client = SimpleMcpClient.spawn(['--demo']);
  let initResult;
  await check('spawn gateway + initialize', async () => {
    initResult = await client.initialize('doctor');
    if (initResult.serverInfo?.name !== SERVER_NAME) throw new Error(`unexpected serverInfo: ${JSON.stringify(initResult.serverInfo)}`);
    return `${initResult.serverInfo.name} v${initResult.serverInfo.version} · protocol ${initResult.protocolVersion}`;
  });
  await check('meta-tool footprint', async () => {
    const res = await client.request('tools/list', {});
    const tools = res.result?.tools || [];
    if (tools.length !== 6) throw new Error(`expected 6 meta-tools, got ${tools.length}`);
    const bytes = JSON.stringify(tools).length;
    if (bytes > 6000) throw new Error(`meta-tool list is ${bytes} bytes — too heavy`);
    return `6 tools · ${bytes} bytes ≈ ${Math.ceil(bytes / 4)} tokens`;
  });
  await check('cs_discover aggregates 3 demo servers', async () => {
    const res = await client.request('tools/call', { name: 'cs_discover', arguments: {} });
    const text = res.result?.content?.[0]?.text || '';
    if (!text.includes('16 tool(s)')) throw new Error(`expected 16 tools in catalog, got: ${text.split('\n')[0]}`);
    return text.split('\n')[0];
  });
  await check('cs_plan recommends tools', async () => {
    const res = await client.request('tools/call', { name: 'cs_plan', arguments: { task: 'add two numbers then read the todo file' } });
    const text = res.result?.content?.[0]?.text || '';
    if (!text.includes('demo-calc__add') || !text.includes('demo-fs__read_file')) throw new Error('planner missed obvious tools');
    return 'demo-calc__add + demo-fs__read_file';
  });
  let gotListChanged = false;
  client.onNotification = (msg) => { if (msg.method === 'notifications/tools/list_changed') gotListChanged = true; };
  await check('cs_load exposes tools + list_changed', async () => {
    const res = await client.request('tools/call', { name: 'cs_load', arguments: { tools: ['demo-calc__add'] } });
    if (res.error) throw new Error(res.error.message);
    if (res.result?.isError) throw new Error(res.result.content?.[0]?.text);
    const text = res.result?.content?.[0]?.text || '';
    if (!text.includes('demo-calc__add')) throw new Error('loaded schema missing from result');
    await new Promise((r) => setTimeout(r, 150));
    if (!gotListChanged) throw new Error('notifications/tools/list_changed was not delivered');
    const list = await client.request('tools/list', {});
    const names = (list.result?.tools || []).map((t) => t.name);
    if (!names.includes('demo-calc__add')) throw new Error('loaded tool missing from tools/list');
    return 'schema echoed + list_changed + tools/list updated';
  });
  await check('direct tools/call routes to downstream', async () => {
    const res = await client.request('tools/call', { name: 'demo-calc__add', arguments: { a: 41, b: 1 } });
    if (res.result?.content?.[0]?.text !== '42') throw new Error(`expected 42, got ${JSON.stringify(res.result?.content?.[0]?.text)}`);
    return 'demo-calc__add(41, 1) = 42';
  });
  await check('cs_call auto-routes without loading', async () => {
    const res = await client.request('tools/call', { name: 'cs_call', arguments: { tool: 'demo-fs__read_file', args: { path: 'README.txt' } } });
    const text = res.result?.content?.[0]?.text || '';
    if (!text.includes('Context-Saver demo filesystem')) throw new Error('read_file content unexpected');
    return 'read README.txt through the gateway';
  });
  await check('token accounting reports savings', async () => {
    const res = await client.request('tools/call', { name: 'cs_status', arguments: {} });
    const sc = res.result?.structuredContent;
    if (!sc || typeof sc.tokens?.savedTokens !== 'number' || sc.tokens.savedTokens <= 0) throw new Error('no savings reported');
    return `saved ≈${fmtTokens(sc.tokens.savedTokens)} tok (${sc.tokens.savedPct}%)`;
  });
  await check('downstream error surfaces as isError', async () => {
    const res = await client.request('tools/call', { name: 'cs_call', arguments: { tool: 'demo-chaos__fail', args: { mode: 'error' } } });
    if (res.result?.isError !== true) throw new Error('expected isError:true result');
    return 'isError:true propagated';
  });
  client.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${SERVER_TITLE} v${VERSION} — doctor\n${paint('dim', '='.repeat(52))}`);
  for (const r of results) {
    console.log(`${r.ok ? paint('green', '✔') : paint('red', '✘')} ${r.name}${r.detail ? paint('dim', ` — ${r.detail}`) : ''}`);
  }
  console.log(`${paint('dim', '='.repeat(52))}`);
  if (userConfigNote) console.log(paint('dim', `user config under test: ${userConfigNote}`));
  console.log(failed.length === 0
    ? `${paint('green', 'All checks passed')} in ${((Date.now() - started) / 1000).toFixed(1)}s`
    : `${paint('red', `${failed.length} check(s) failed`)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// [15] CLI entry point
// ---------------------------------------------------------------------------

const HELP = `
${SERVER_TITLE} v${VERSION} — one MCP connection, every tool, ~90% less context.

USAGE
  context-saver                          run the gateway on stdio (for Claude Code / Cursor)
  context-saver --demo                   stdio gateway + 3 built-in demo servers, zero setup
  context-saver --client [--demo]        interactive terminal client (great with --demo)
  context-saver --doctor                 end-to-end self-diagnostic (exit 0 = healthy)
  context-saver --transport http [...]   remote gateway: Streamable HTTP + legacy SSE + OAuth

OPTIONS
  --config <file>        gateway config (default: $CONTEXT_SAVER_CONFIG, ./context-saver.config.json,
                         or ~/.context-saver/config.json). Accepts Claude-style "mcpServers" blocks.
  --demo                 ignore the config and spin up demo-fs / demo-calc / demo-chaos
  --client               start the interactive REPL client instead of serving
  --doctor               run self-checks and exit
  --transport <t>        stdio (default) | http
  --host <h>             HTTP bind host (default 127.0.0.1)
  --port <n>             HTTP port (default ${DEFAULT_HTTP_PORT}; 0 = pick one)
  --port-file <file>     write the actual HTTP port here (useful for tests)
  --auth | --no-auth     OAuth 2.1 gate for HTTP mode (default: on). Binding a non-loopback
                         host without --auth is refused unless --insecure is also given.
  --public-url <url>     external base URL for OAuth metadata (behind a reverse proxy)
  --allowed-origin <o>   allow this Origin (repeatable) in addition to same-origin/loopback
  --cache-dir <dir>      catalog cache location (default: ~/.context-saver or $TMPDIR)
  --insecure             acknowledge the risk of an unauthenticated non-loopback bind
  --version              print version
  --help                 this help

ENVIRONMENT
  CONTEXT_SAVER_CONFIG            config file path
  CONTEXT_SAVER_LOG               silent | error | warn | info (default) | debug
  CONTEXT_SAVER_PAGE_SIZE         tools/list page size (default 100)
  CONTEXT_SAVER_SESSION_TTL_MS    idle HTTP session lifetime (default 30 min)
  CONTEXT_SAVER_DOWNSTREAM_IDLE_MS  idle downstream reaping (default 10 min, 0 = off)
  CONTEXT_SAVER_TOKEN_TTL_MS      OAuth access-token lifetime (default 1 h)

The entire gateway is one zero-dependency file. MIT licensed.
`.trim();

function parseArgs(argv) {
  const out = {
    transport: 'stdio', host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT,
    auth: null, allowedOrigins: [], _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--config': out.config = next(); break;
      case '--transport': {
        const t = next();
        if (!['stdio', 'http'].includes(t)) throw new Error(`--transport must be stdio or http, got "${t}"`);
        out.transport = t;
        break;
      }
      case '--host': out.host = next(); break;
      case '--port': {
        const p = Number.parseInt(next(), 10);
        if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error('--port must be 0..65535');
        out.port = p;
        break;
      }
      case '--port-file': out.portFile = next(); break;
      case '--auth': out.auth = true; break;
      case '--no-auth': out.auth = false; break;
      case '--allowed-origin': out.allowedOrigins.push(next()); break;
      case '--public-url': out.publicUrl = next().replace(/\/$/, ''); break;
      case '--cache-dir': out.cacheDir = next(); break;
      case '--demo': out.demo = true; break;
      case '--demo-server': out.demoServer = next(); break;
      case '--client': out.client = true; break;
      case '--doctor': out.doctor = true; break;
      case '--insecure': out.insecure = true; break;
      case '--version': case '-v': out.version = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`unknown option "${a}" (see --help)`);
    }
  }
  return out;
}

function isLoopbackBind(host) {
  return ['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'].includes(String(host).toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { console.log(HELP); return; }
  if (args.version) { console.log(VERSION); return; }
  if (args.demoServer) {
    if (!DEMO_SERVER_NAMES.includes(args.demoServer)) {
      console.error(`unknown demo server "${args.demoServer}" (available: ${DEMO_SERVER_NAMES.join(', ')})`);
      process.exit(2);
    }
    return runDemoServer(args.demoServer);
  }
  if (args.doctor) return runDoctor(args);
  if (args.client) return runReplClient(args);

  if (args.demo && args.config) {
    console.error('use either --demo or --config, not both');
    process.exit(2);
  }

  let configPath = args.config;
  if (args.demo) configPath = buildDemoConfigFile();
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${err.message}`);
      for (const issue of err.issues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    throw err;
  }

  const manager = new DownstreamManager({
    servers: config.servers,
    defaults: config.defaults,
    cacheDir: args.cacheDir,
    useCache: !args.demo, // demo servers are ephemeral — never read/write their catalog
  });
  const engine = new GatewayEngine({ manager, configPath: config.path });

  if (args.transport === 'stdio') {
    log.info('gateway', `${SERVER_TITLE} v${VERSION} starting (stdio) — ${manager.serverNames().length} downstream server(s)${args.demo ? ' [demo mode]' : ''}`);
    if (manager.serverNames().length === 0) {
      log.warn('gateway', 'no downstream servers configured — the gateway still runs; see cs_discover for setup help');
    }
    return runStdioGateway({ engine, manager });
  }

  // --- HTTP mode -------------------------------------------------------------
  const authOn = args.auth !== false;
  if (!isLoopbackBind(args.host) && !authOn && !args.insecure) {
    console.error(`refusing to bind http://${args.host}:${args.port} without authentication.\n` +
      '  use --auth (recommended), bind a loopback --host, or pass --insecure to accept the risk.');
    process.exit(2);
  }
  const auth = authOn ? new OAuthProvider({}) : null;
  const server = createGatewayHttpServer({
    engine, manager, auth,
    allowedOrigins: args.allowedOrigins,
    getIssuerBase: args.publicUrl ? () => args.publicUrl : null,
  });

  const shutdown = () => {
    try { server.__shutdown(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(args.port, args.host, () => {
    const addr = server.address();
    const displayHost = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    const base = args.publicUrl || `http://${displayHost}:${addr.port}`;
    log.info('gateway', `${SERVER_TITLE} v${VERSION} listening on ${base}/mcp (${manager.serverNames().length} downstream server(s))`);
    if (auth) {
      log.info('oauth', `authorization server at ${base}/authorize — MCP clients will pop up a login automatically`);
    } else {
      log.warn('oauth', 'authentication disabled (--no-auth) — anyone who can reach this port can use the gateway');
    }
    log.info('gateway', `health check: ${base}/health`);
    if (args.portFile) {
      try { writeFileSync(args.portFile, String(addr.port), 'utf8'); } catch (err) { log.warn('gateway', `cannot write port file: ${err.message}`); }
    }
  });
  server.on('error', (err) => {
    console.error(`cannot listen on ${args.host}:${args.port}: ${err.message}`);
    process.exit(1);
  });
}

function isMain() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// [16] exports (used by the test suite; importing never starts the server)
// ---------------------------------------------------------------------------

export {
  VERSION, SERVER_NAME, SERVER_TITLE, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION,
  INSTRUCTIONS, META_TOOLS, META_TOOL_NAMES, DEMO_SERVER_NAMES,
  ErrorCode, rpcResponse, rpcError, isJsonRpcRequest, isJsonRpcNotification,
  estimateTokens, sanitizeToolName, matchGlob, globToRegExp, tokenize, scoreTools,
  pkceChallengeFromVerifier, verifyPkce, b64url,
  ConfigError, ToolCallError, DownstreamRpcError, loadConfig, findConfigFile, expandEnv,
  CatalogCache, normalizeToolDef,
  BaseDownstream, StdioDownstream, HttpDownstream, SseParser, DownstreamManager, createDownstream,
  GatewayEngine, GatewaySession, resolvePatterns, suggestIds, editDistance,
  createGatewayHttpServer, runStdioGateway, OAuthProvider, approvalPageHtml, escapeHtml,
  buildDemoConfigFile, runDemoServer, SimpleMcpClient, runDoctor, runReplClient,
  serializeWrite, SETTINGS,
};
