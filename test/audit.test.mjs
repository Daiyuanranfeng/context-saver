// Audit probes: adversarial tests written AFTER implementation, hunting for
// bugs that bite real users. Each probe documents a finding; the ones that
// fail are reproduced here before being fixed (test-first).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import * as CS from '../context-saver.mjs';

const SELF = realpathSync(fileURLToPath(new URL('../context-saver.mjs', import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), 'cs-audit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (client, name, args) => client.request('tools/call', { name, arguments: args });
const textOf = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';

const rawExchange = (client, line, timeoutMs = 5_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no raw response')), timeoutMs);
  client.onUnhandledMessage = (msg) => {
    clearTimeout(timer);
    client.onUnhandledMessage = null;
    resolve(msg);
  };
  client.child.stdin.write(`${line}\n`);
});

// ---------------------------------------------------------------- probes that
// should PASS (defenses already in place — regression protection)

describe('audit: defenses verified', () => {
  test('client aborting mid-SSE-response does not kill the HTTP gateway', async () => {
    const portFile = path.join(TMP, `abort-${Math.random().toString(36).slice(2)}.txt`);
    const child = spawn(process.execPath, [SELF, '--transport', 'http', '--port', '0', '--port-file', portFile, '--demo', '--no-auth'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CONTEXT_SAVER_LOG: 'silent' },
    });
    try {
      let port;
      for (let i = 0; i < 100 && !port; i++) { await sleep(50); try { port = Number(readFileSync(portFile, 'utf8').trim()); } catch { /* not yet */ } }
      assert.ok(port, 'gateway did not start');
      const base = `http://127.0.0.1:${port}`;
      const init = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'abort-test', version: '1' } } }),
      });
      const sessionId = init.headers.get('mcp-session-id');
      await init.arrayBuffer();

      // long-running call, aborted mid-flight
      const controller = new AbortController();
      const slow = fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cs_call', arguments: { tool: 'demo-chaos__slow', args: { seconds: 5 } } } }),
        signal: controller.signal,
      }).catch(() => null);
      await sleep(150);
      controller.abort();
      await slow;

      // gateway must still serve
      const ping = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      });
      assert.equal(ping.status, 200);
      assert.deepEqual((await ping.json()).result, {});
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('parallel cs_load of the same server spawns exactly one downstream process', async () => {
    const client = CS.SimpleMcpClient.spawn(['--demo']);
    try {
      await client.initialize('audit-dedup');
      await Promise.all([
        call(client, 'cs_load', { tools: ['demo-calc__add'] }),
        call(client, 'cs_load', { tools: ['demo-calc__multiply'] }),
        call(client, 'cs_load', { tools: ['demo-calc__stats'] }),
        call(client, 'cs_load', { tools: ['demo-calc:now'] }),
      ]);
      const status = await call(client, 'cs_status', {});
      // getCatalog connects each of the 3 demo servers exactly once; the four
      // concurrent loads must not multiply that (12 would mean no dedup at all).
      assert.equal(status.result.structuredContent.manager.connects, 3, 'exactly one connect per server despite 4 concurrent loads');
      const pids = status.result.structuredContent.servers.map((s) => s.pid).filter(Boolean);
      assert.equal(pids.length, 3);
    } finally {
      client.close();
    }
  });

  test('binding a non-loopback host without auth is refused', async () => {
    const child = spawn(process.execPath, [SELF, '--transport', 'http', '--host', '0.0.0.0', '--no-auth', '--port', '0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CONTEXT_SAVER_LOG: 'silent' },
    });
    const stderr = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => stderr.push(d));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 2);
    assert.ok(stderr.join('').includes('refusing'), stderr.join(''));
  });

  test('idle downstream connections are reaped and respawn transparently', async () => {
    const client = CS.SimpleMcpClient.spawn(['--demo'], { env: { CONTEXT_SAVER_DOWNSTREAM_IDLE_MS: '1200' } });
    try {
      await client.initialize('audit-reap');
      const res = await call(client, 'cs_load', { tools: ['demo-calc__add'] });
      assert.ok(textOf(res).includes('Loaded 1 tool(s)'));
      let status = await call(client, 'cs_status', {});
      const pid = status.result.structuredContent.servers.find((s) => s.name === 'demo-calc').pid;
      assert.ok(pid);
      const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
      assert.ok(alive(pid));

      await sleep(7_000); // idle sweep runs every 5s
      assert.equal(alive(pid), false, 'idle downstream must be reaped');
      status = await call(client, 'cs_status', {});
      assert.equal(status.result.structuredContent.servers.find((s) => s.name === 'demo-calc').state, 'disconnected');

      const again = await call(client, 'demo-calc__add', { a: 5, b: 6 });
      assert.equal(textOf(again), '11');
      status = await call(client, 'cs_status', {});
      const pid2 = status.result.structuredContent.servers.find((s) => s.name === 'demo-calc').pid;
      assert.ok(pid2 && pid2 !== pid, 'a fresh process must have been spawned');
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------- fix 1
describe('audit: fix 1 — cancellation hygiene', () => {
  test('a late cancellation must not suppress a future request reusing the id', async () => {
    const client = CS.SimpleMcpClient.spawn(['--demo']);
    try {
      await client.initialize('audit-cancel');
      const rawId = 'reused-id-7';
      const first = await rawExchange(client, JSON.stringify({ jsonrpc: '2.0', id: rawId, method: 'ping' }));
      assert.deepEqual(first.result, {});
      // the cancellation arrives AFTER the reply was already sent (late cancel)
      client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: rawId } })}\n`);
      await sleep(150);
      // a later request that reuses the same id must still receive its reply
      const second = await rawExchange(client, JSON.stringify({ jsonrpc: '2.0', id: rawId, method: 'tools/list' }), 4_000).catch(() => null);
      assert.ok(second && second.result, `late cancellation suppressed the reply for a reused id: ${JSON.stringify(second)}`);
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------- fix 2
describe('audit: fix 2 — legacy SSE session sweep', () => {
  test('idle legacy-SSE sessions are swept AND their streams closed', async () => {
    const portFile = path.join(TMP, `legacy-${Math.random().toString(36).slice(2)}.txt`);
    const child = spawn(process.execPath, [SELF, '--transport', 'http', '--port', '0', '--port-file', portFile, '--demo', '--no-auth'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CONTEXT_SAVER_LOG: 'silent', CONTEXT_SAVER_SESSION_TTL_MS: '1500' },
    });
    try {
      let port;
      for (let i = 0; i < 150 && !port; i++) {
        await sleep(50);
        try { port = Number(readFileSync(portFile, 'utf8').trim()); } catch { /* not yet */ }
      }
      assert.ok(port, 'gateway did not start');
      const base = `http://127.0.0.1:${port}`;

      const controller = new AbortController();
      const res = await fetch(`${base}/sse`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
      assert.equal(res.status, 200);
      let endpoint = null;
      const parser = new CS.SseParser(({ event, data }) => { if (event === 'endpoint') endpoint = data; });
      const reader = Readable.fromWeb(res.body);
      reader.on('data', (c) => parser.push(c));
      const deadline = Date.now() + 4_000;
      while (!endpoint && Date.now() < deadline) await sleep(25);
      assert.ok(endpoint, 'no endpoint event');

      const streamEnded = new Promise((resolve) => { reader.once('end', resolve); reader.once('error', resolve); });
      const ended = await Promise.race([streamEnded.then(() => true), sleep(8_000).then(() => false)]);
      assert.ok(ended, 'the server must close the idle legacy SSE stream after the session TTL');

      // and the session must really be gone
      const post = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
      }).catch(() => null);
      assert.ok(!post || post.status === 404, 'swept session must reject further messages');
      controller.abort();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

// ---------------------------------------------------------------- fix 3
describe('audit: fix 3 — rate limiter memory bound', () => {
  test('the token-endpoint rate limiter does not grow without bound', () => {
    const provider = new CS.OAuthProvider({});
    const fakeReq = (ip) => ({ socket: { remoteAddress: ip } });
    for (let i = 0; i < 20_000; i++) provider._rateLimited(fakeReq(`10.${i % 256}.${Math.floor(i / 256) % 256}.${(i % 254) + 1}`));
    assert.ok(provider._rate.size <= 4_096, `rate-limit map holds ${provider._rate.size} entries — unbounded growth`);
  });
});
