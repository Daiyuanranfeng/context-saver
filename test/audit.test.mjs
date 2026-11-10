// Audit probes: adversarial tests written AFTER implementation, hunting for
// bugs that bite real users. Each probe documents a finding; the ones that
// fail are reproduced here before being fixed (test-first).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
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
  for (const stream of [false, true]) {
    test(`cancellation aborts a downstream ${stream ? 'SSE body' : 'HTTP request'}`, { timeout: 8_000 }, async () => {
      let start;
      let stop;
      let cancel;
      const started = new Promise((resolve) => { start = resolve; });
      const stopped = new Promise((resolve) => { stop = resolve; });
      const cancelled = new Promise((resolve) => { cancel = resolve; });
      let streamRequestId;
      const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const msg = JSON.parse(Buffer.concat(chunks));
        if (msg.method === 'notifications/cancelled') cancel(msg.params.requestId);
        if (msg.id === undefined) { res.writeHead(202).end(); return; }
        if (msg.id === 'sse-ready') {
          res.writeHead(202).end();
          start(streamRequestId);
          return;
        }
        if (msg.method === 'tools/call' && msg.params.arguments.slow) {
          res.once('close', stop);
          if (stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            streamRequestId = msg.id;
            res.write('data: {"jsonrpc":"2.0","id":"sse-ready","method":"ping"}\n\n');
          } else {
            start(msg.id);
          }
          return;
        }
        const result = msg.method === 'initialize'
          ? { protocolVersion: CS.LATEST_PROTOCOL_VERSION, capabilities: { tools: {} } }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'completed' }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(CS.rpcResponse(msg.id, result)));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const manager = new CS.DownstreamManager({
        useCache: false,
        servers: { remote: { name: 'remote', type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` } },
      });
      try {
        const engine = new CS.GatewayEngine({ manager });
        const session = engine.createSession();
        const request = (slow) => ({
          jsonrpc: '2.0', id: 'upstream-id', method: 'tools/call',
          params: { name: 'cs_call', arguments: { tool: 'remote__slow', args: { slow } } },
        });
        const pending = engine.handleRequest(request(true), session);
        const downstreamId = await started;
        engine.handleNotification({
          jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'upstream-id' },
        }, session);
        const observed = await Promise.race([
          Promise.all([stopped, cancelled]).then(([, id]) => id),
          sleep(2_000).then(() => 'not cancelled'),
        ]);
        assert.equal(observed, downstreamId);
        assert.equal((await pending).wasCancelled, true);
        assert.equal(textOf((await engine.handleRequest(request(false), session)).reply), 'completed');
      } finally {
        manager.shutdown();
        server.closeAllConnections();
        server.close();
      }
    });
  }


  test('cancellation drops the pending stdio reply and keeps the child usable', { timeout: 8_000 }, async () => {
    const manager = new CS.DownstreamManager({
      useCache: false,
      servers: {
        chaos: { name: 'chaos', type: 'stdio', command: process.execPath, args: [SELF, '--demo-server', 'demo-chaos'] },
      },
    });
    try {
      const conn = await manager.ensureConnected('chaos');
      const engine = new CS.GatewayEngine({ manager });
      const session = engine.createSession();
      const request = (tool, args) => ({
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'cs_call', arguments: { tool: 'chaos__' + tool, args } },
      });
      const pending = engine.handleRequest(request('slow', { seconds: 2 }), session);
      for (let i = 0; i < 200 && conn.inflight === 0; i++) await sleep(5);
      assert.equal(conn.inflight, 1);
      engine.handleNotification({
        jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 },
      }, session);
      assert.equal(conn.inflight, 0);
      assert.equal((await pending).wasCancelled, true);
      const next = await engine.handleRequest(request('echo', { message: 'still here' }), session);
      assert.match(textOf(next.reply), /still here/);
      assert.equal(await manager.ensureConnected('chaos'), conn);
    } finally {
      manager.shutdown();
    }
  });

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

// ---------------------------------------------------------------- fix 4
describe('audit: fix 4 — demo config cleanup', () => {
  test('demo config files do not accumulate in tmpdir after gateway exit', async () => {
    const listDemoConfigs = () => {
      try {
        return readdirSync(tmpdir()).filter((f) => f.startsWith('context-saver-demo-') && f.endsWith('.json'));
      } catch {
        return [];
      }
    };
    const before = listDemoConfigs().length;
    const client = CS.SimpleMcpClient.spawn(['--demo']);
    await client.initialize('audit-litter');
    await call(client, 'cs_discover', {});
    client.child.kill('SIGTERM');
    await new Promise((resolve) => client.child.on('exit', resolve));
    await sleep(300);
    const after = listDemoConfigs().length;
    assert.equal(after, before, `demo config files leaked in ${tmpdir()} (${before} -> ${after})`);
  });
});

// ---------------------------------------------------------------- audit round 2
describe('audit: round 2 — fix 6 (OAuth approval needs a human)', () => {
  const spawnGw = (extraArgs, env = {}) => {
    const portFile = path.join(TMP, `r2-${Math.random().toString(36).slice(2)}.txt`);
    const child = spawn(process.execPath, [SELF, '--transport', 'http', '--port', '0', '--port-file', portFile, '--demo', ...extraArgs], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CONTEXT_SAVER_LOG: 'silent', ...env },
    });
    const base = (async () => {
      for (let i = 0; i < 200; i++) {
        await sleep(50);
        try { return `http://127.0.0.1:${Number(readFileSync(portFile, 'utf8').trim())}`; } catch { /* not yet */ }
      }
      throw new Error('gateway did not start');
    })();
    return { child, base, stop: () => child.kill('SIGKILL') };
  };
  const register = async (base, name = 'probe-client') => fetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: ['http://127.0.0.1:1/cb'], token_endpoint_auth_method: 'none' }),
  }).then((r) => r.json());
  const scriptedApprove = (base, clientId, challenge) => fetch(`${base}/authorize`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      action: 'approve', client_id: clientId, redirect_uri: 'http://127.0.0.1:1/cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp',
    }).toString(),
    redirect: 'manual',
  });

  test('the three-POST self-approval (register -> approve -> token) is rejected', async () => {
    const gw = await spawnGw([]); // auth on, loopback: CSRF token still required
    try {
      const base = await gw.base;
      const reg = await register(base, 'scripted-attacker');
      const dec = await scriptedApprove(base, reg.client_id, 'a'.repeat(43));
      assert.equal(dec.status, 400, 'approval without the consent page token must be rejected');
      const html = await dec.text();
      assert.ok(html.includes('Stale authorization'), 'error page should explain the rejection');
    } finally { gw.stop(); }
  });

  test('the real browser flow still works: page token + pairing code', async () => {
    const gw = await spawnGw(['--approval-token', 'pair-secret-123']);
    try {
      const base = await gw.base;
      const reg = await register(base, 'legit-client');
      const page = await fetch(`${base}/authorize?${new URLSearchParams({
        client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:1/cb', response_type: 'code',
        code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', scope: 'mcp',
      })}`);
      const html = await page.text();
      assert.ok(html.includes('Pairing code'), 'consent page must ask for the pairing code');
      const approvalToken = /name="approval_token" value="([^"]+)"/.exec(html)?.[1];
      assert.ok(approvalToken);

      const wrong = await fetch(`${base}/authorize`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'approve', approval_token: approvalToken, pairing_code: 'wrong', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:1/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }).toString(),
        redirect: 'manual',
      });
      assert.equal(wrong.status, 403, 'wrong pairing code must be rejected');

      const page2 = await fetch(`${base}/authorize?${new URLSearchParams({
        client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:1/cb', response_type: 'code',
        code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', scope: 'mcp',
      })}`);
      const approvalToken2 = /name="approval_token" value="([^"]+)"/.exec(await page2.text())?.[1];
      const right = await fetch(`${base}/authorize`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'approve', approval_token: approvalToken2, pairing_code: 'pair-secret-123', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:1/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' }).toString(),
        redirect: 'manual',
      });
      assert.equal(right.status, 302);
      assert.ok(new URL(right.headers.get('location')).searchParams.get('code'), 'correct pairing code mints the authorization code');
    } finally { gw.stop(); }
  });

  test('binding non-loopback with auth but no --approval-token is refused', async () => {
    const child = spawn(process.execPath, [SELF, '--transport', 'http', '--host', '0.0.0.0', '--port', '0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CONTEXT_SAVER_LOG: 'silent' },
    });
    const stderr = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => stderr.push(d));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 2);
    assert.ok(stderr.join('').includes('approval'), stderr.join(''));
  });
});

// ---------------------------------------------------------------- fix 7
describe('audit: round 2 — fix 7 (expired OAuth state is purged)', () => {
  test('issuing tokens sweeps expired codes, refresh tokens, access tokens and approvals', () => {
    const p = new CS.OAuthProvider({ tokenTtlMs: 60_000, refreshTokenTtlMs: 60_000 });
    const past = Date.now() - 1;
    p.codes.set('csc_dead', { clientId: 'x', redirectUri: 'https://a/cb', challenge: 'a'.repeat(43), scope: 'mcp', expiresAt: past, consumed: false });
    p.refreshTokens.set('csrt_dead', { clientId: 'x', scope: 'mcp', expiresAt: past });
    p.tokens.set('csat_dead', { clientId: 'x', scope: 'mcp', expiresAt: past });
    p._approvals.set('csap_dead', past);
    p._issueTokens('x', 'mcp'); // any issuance sweeps
    assert.equal(p.codes.size, 0, 'expired codes must be purged');
    assert.equal(p.refreshTokens.size, 1, 'only the freshly issued refresh token may remain');
    assert.equal(p.refreshTokens.has('csrt_dead'), false, 'the dead refresh token must be gone');
    assert.equal(p.tokens.size, 1, 'only the freshly issued access token may remain');
    assert.equal(p.tokens.has('csat_dead'), false, 'the dead access token must be gone');
    assert.equal(p._approvals.size, 0, 'expired approval tokens must be purged');
  });

  test('long-running growth: 5000 abandoned authorizations leave no residue', () => {
    const p = new CS.OAuthProvider({});
    for (let i = 0; i < 5_000; i++) {
      p._approvals.set(`csap_${i}`, Date.now() - 1);
      p.codes.set(`csc_${i}`, { clientId: 'x', redirectUri: 'https://a/cb', challenge: 'a'.repeat(43), scope: 'mcp', expiresAt: Date.now() - 1, consumed: false });
    }
    p._lastSweep = 0; // force a sweep on the next touch
    p._issueTokens('x', 'mcp');
    assert.equal(p.codes.size, 0);
    assert.equal(p._approvals.size, 0);
  });
});

// ---------------------------------------------------------------- fix 8
describe('audit: round 2 — fix 8 (malformed percent-encoding answers 4xx, not 500)', () => {
  test('POST /token, POST /authorize and GET paths with invalid %-escapes return 4xx', async () => {
    const portFile = path.join(TMP, `pct-${Math.random().toString(36).slice(2)}.txt`);
    const child = spawn(process.execPath, [SELF, '--transport', 'http', '--port', '0', '--port-file', portFile, '--demo'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CONTEXT_SAVER_LOG: 'silent' },
    });
    try {
      let base;
      for (let i = 0; i < 200; i++) { await sleep(50); try { base = `http://127.0.0.1:${Number(readFileSync(portFile, 'utf8').trim())}`; if (base) break; } catch { /* not yet */ } }
      assert.ok(base, 'gateway did not start');
      // auth is ON so the OAuth endpoints are mounted; body parsing happens
      // before client validation, so no valid client is needed to test decoding
      const token = await fetch(`${base}/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=%E0%A4%A&client_id=x',
      });
      assert.equal(token.status, 400, `token endpoint returned ${token.status}`);
      const auth = await fetch(`${base}/authorize`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=approve&client_id=%FF&redirect_uri=%C3',
      });
      assert.equal(auth.status, 400, `authorize endpoint returned ${auth.status}`);
      const path404 = await fetch(`${base}/%zz`);
      assert.equal(path404.status, 404, `raw path returned ${path404.status}`);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

// ---------------------------------------------------------------- fix 9
describe('audit: round 2 — fix 9 (config lookup works without $HOME)', () => {
  test('findConfigFile falls back to os.homedir(), not the tmpdir, when HOME is unset', () => {
    const home = homedir();
    const marker = path.join(home, '.context-saver', 'config.json');
    const backup = (() => { try { return readFileSync(marker, 'utf8'); } catch { return null; } })();
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ servers: { probe: { command: 'node', args: ['x'] } } }));
    const savedHome = process.env.HOME;
    try {
      delete process.env.HOME;
      const found = CS.findConfigFile(null);
      assert.equal(found, marker, `expected ${marker}, got ${found}`);
    } finally {
      process.env.HOME = savedHome;
      if (backup === null) rmSync(marker, { force: true });
      else writeFileSync(marker, backup);
    }
  });
});
