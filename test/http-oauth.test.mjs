// HTTP transport + OAuth 2.1 provider end-to-end tests (real HTTP servers).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import * as CS from '../context-saver.mjs';

const SELF = realpathSync(fileURLToPath(new URL('../context-saver.mjs', import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), 'cs-http-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gateways = [];
function spawnHttp(extraArgs = [], env = {}) {
  const portFile = path.join(TMP, `port-${Math.random().toString(36).slice(2)}.txt`);
  const child = spawn(process.execPath, [SELF, '--transport', 'http', '--port', '0', '--port-file', portFile, '--demo', ...extraArgs], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CONTEXT_SAVER_LOG: 'warn', ...env },
  });
  gateways.push(child);
  const deadline = Date.now() + 15_000;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      let port;
      try { port = Number(readFileSync(portFile, 'utf8').trim()); } catch { /* not yet */ }
      if (port) {
        clearInterval(poll);
        resolve({ child, port, base: `http://127.0.0.1:${port}`, stop: () => child.kill('SIGTERM') });
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('gateway did not start in 15s'));
      }
    }, 40);
  });
}
after(() => { for (const g of gateways) { try { g.kill('SIGKILL'); } catch { /* ignore */ } } });

const postMcp = (base, body, headers = {}) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const readAllSse = async (res) => {
  const events = [];
  const parser = new CS.SseParser(({ event, data }) => {
    let parsed = data;
    try { parsed = JSON.parse(data); } catch { /* keep raw */ }
    events.push({ event, data: parsed });
  });
  for await (const chunk of Readable.fromWeb(res.body)) parser.push(chunk);
  return events;
};

class SseCollector {
  async start(url, headers = {}) {
    this.controller = new AbortController();
    this.events = [];
    this.res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: this.controller.signal });
    if (!this.res.ok) throw new Error(`SSE stream refused: HTTP ${this.res.status}`);
    const parser = new CS.SseParser(({ event, data }) => {
      let parsed = data;
      try { parsed = JSON.parse(data); } catch { /* keep raw */ }
      this.events.push({ event, data: parsed });
    });
    this.reader = Readable.fromWeb(this.res.body);
    this.reader.on('data', (chunk) => parser.push(chunk));
    this.reader.on('error', () => {});
    return this;
  }
  async waitUntil(pred, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(pred);
      if (found) return found;
      await sleep(25);
    }
    throw new Error(`condition not met within ${timeoutMs}ms; events=${JSON.stringify(this.events).slice(0, 400)}`);
  }
  abort() { try { this.controller.abort(); } catch { /* ignore */ } }
}

const b64urlSha = (s) => createHash('sha256').update(s).digest('base64url').replace(/=+$/, '');
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });

describe('streamable HTTP transport (no auth)', () => {
  let gw_;
  let sessionId;
  before(async () => { gw_ = await spawnHttp(['--no-auth']); });
  after(() => { try { gw_.stop(); } catch { /* ignore */ } });

  test('GET /health reports ok without auth', async () => {
    const res = await fetch(`${gw_.base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.server, 'context-saver');
    assert.ok(Array.isArray(body.servers));
  });

  test('initialize over POST returns JSON + session id header', async () => {
    const res = await postMcp(gw_.base, rpc(1, 'initialize', {
      protocolVersion: CS.LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'http-test', version: '1.0.0' },
    }));
    assert.equal(res.status, 200);
    assert.equal((res.headers.get('content-type') || '').includes('application/json'), true);
    sessionId = res.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize must issue Mcp-Session-Id');
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, 'context-saver');
    assert.equal(body.result.capabilities.tools.listChanged, true);
  });

  test('requests without a session header are rejected 400', async () => {
    const res = await postMcp(gw_.base, rpc(2, 'tools/list', {}));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.message.includes('Mcp-Session-Id'));
  });

  test('unknown session id is 404 with -32001', async () => {
    const res = await postMcp(gw_.base, rpc(3, 'tools/list', {}), { 'mcp-session-id': 'bogus-session' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, -32001);
  });

  test('bad Accept header is 406; bad Content-Type is 415; wrong method is 405', async () => {
    const h = { 'mcp-session-id': sessionId };
    const a = await fetch(`${gw_.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' });
    assert.equal(a.status, 406);
    const b = await fetch(`${gw_.base}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' }, body: 'x' });
    assert.equal(b.status, 415);
    const c = await fetch(`${gw_.base}/mcp`, { method: 'PUT', headers: h });
    assert.equal(c.status, 405);
    assert.ok((c.headers.get('allow') || '').includes('GET'));
  });

  test('unsupported MCP-Protocol-Version header is 400 with the supported list', async () => {
    const res = await postMcp(gw_.base, rpc(4, 'tools/list', {}), { 'mcp-session-id': sessionId, 'mcp-protocol-version': '1999-01-01' });
    assert.equal(res.status, 400);
    const msg = (await res.json()).error.message;
    assert.ok(msg.includes('2025-06-18'), msg);
  });

  test('invalid JSON body is 400 -32700; non-JSON-RPC JSON is 400 too', async () => {
    const h = { 'mcp-session-id': sessionId };
    const res = await postMcp(gw_.base, 'garbage{{', h);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
    const res2 = await postMcp(gw_.base, '[1,2,3]', h);
    assert.equal(res2.status, 400);
    const res3 = await postMcp(gw_.base, '{"hello":"world"}', h);
    assert.equal(res3.status, 400);
  });

  test('oversized bodies are rejected 413', async () => {
    const res = await postMcp(gw_.base, 'x'.repeat(5 * 1024 * 1024), { 'mcp-session-id': sessionId });
    assert.equal(res.status, 413);
  });

  test('tools/list and tools/call work over POST with the session header', async () => {
    const h = { 'mcp-session-id': sessionId };
    const list = await postMcp(gw_.base, rpc(6, 'tools/list', {}), h);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).result.tools.length, 6);
    const call = await postMcp(gw_.base, rpc(7, 'tools/call', { name: 'cs_call', arguments: { tool: 'demo-calc__add', args: { a: 20, b: 22 } } }), h);
    const body = await call.json();
    assert.equal(body.result.content[0].text, '42');
  });

  test('notifications get 202 with no body', async () => {
    const res = await postMcp(gw_.base, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  });

  test('cs_load answers via SSE carrying the response AND the notification', async () => {
    const res = await postMcp(gw_.base, rpc(8, 'tools/call', { name: 'cs_load', arguments: { tools: ['demo-calc__add'] } }), { 'mcp-session-id': sessionId });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
    assert.equal(res.headers.get('mcp-session-id'), sessionId);
    const events = await readAllSse(res);
    assert.equal(events.length, 2);
    assert.equal(events[0].data.result.content[0].text.includes('Loaded 1 tool(s)'), true);
    assert.equal(events[1].data.method, 'notifications/tools/list_changed');
  });

  test('GET /mcp opens an SSE stream and receives pushes for later loads', async () => {
    const collector = await new SseCollector().start(`${gw_.base}/mcp`, { 'mcp-session-id': sessionId });
    try {
      const res = await postMcp(gw_.base, rpc(9, 'tools/call', { name: 'cs_load', arguments: { tools: ['demo-fs__read_file'] } }), { 'mcp-session-id': sessionId });
      assert.equal(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('application/json'), 'with an open GET stream the POST reply is plain JSON');
      const pushed = await collector.waitUntil((e) => e.data?.method === 'notifications/tools/list_changed');
      assert.ok(pushed);

      const second = await fetch(`${gw_.base}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId } });
      assert.equal(second.status, 409); // one stream per session
      await second.arrayBuffer().catch(() => {});
    } finally {
      collector.abort();
    }
  });

  test('GET /mcp without Accept: text/event-stream is 406; without session is 400', async () => {
    const a = await fetch(`${gw_.base}/mcp`, { method: 'GET', headers: { accept: 'application/json', 'mcp-session-id': sessionId } });
    assert.equal(a.status, 406);
    const b = await fetch(`${gw_.base}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
    assert.equal(b.status, 400);
  });

  test('cross-origin POSTs are rejected 403, loopback origins allowed', async () => {
    const evil = await postMcp(gw_.base, rpc(10, 'tools/list', {}), { 'mcp-session-id': sessionId, origin: 'https://evil.example.com' });
    assert.equal(evil.status, 403);
    const local = await postMcp(gw_.base, rpc(11, 'tools/list', {}), { 'mcp-session-id': sessionId, origin: 'http://localhost:5173' });
    assert.equal(local.status, 200);
  });

  test('DELETE terminates the session; further requests are 404', async () => {
    const res = await fetch(`${gw_.base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
    assert.equal(res.status, 200);
    const after = await postMcp(gw_.base, rpc(12, 'tools/list', {}), { 'mcp-session-id': sessionId });
    assert.equal(after.status, 404);
  });

  test('legacy SSE transport: endpoint event + POST /messages round trip', async () => {
    const collector = await new SseCollector().start(`${gw_.base}/sse`);
    try {
      const endpoint = await collector.waitUntil((e) => e.event === 'endpoint');
      assert.ok(String(endpoint.data).startsWith('/messages?sessionId='));
      const post = async (body) => fetch(`${gw_.base}${endpoint.data}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let idSeq = 100;
      const roundtrip = async (method, params) => {
        const id = ++idSeq;
        const wait = collector.waitUntil((e) => e.event === 'message' && e.data?.id === id, 8_000);
        const res = await post(rpc(id, method, params));
        assert.equal(res.status, 202);
        const ev = await wait;
        return ev.data;
      };
      const init = await roundtrip('initialize', { protocolVersion: CS.LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } });
      assert.equal(init.result.serverInfo.name, 'context-saver');
      const list = await roundtrip('tools/list', {});
      assert.equal(list.result.tools.length, 6);
      const call = await roundtrip('tools/call', { name: 'cs_call', arguments: { tool: 'demo-calc__multiply', args: { a: 6, b: 7 } } });
      assert.equal(call.result.content[0].text, '42');
    } finally {
      collector.abort();
    }
  });
});

describe('OAuth 2.1 authorization server', () => {
  let gw_;
  let clientId;
  const redirectUri = 'http://127.0.0.1:8923/callback';
  let accessToken;
  let refreshToken;
  let sessionId;
  let authCode;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = b64urlSha(verifier);
  const codeFrom = (location) => new URL(location).searchParams.get('code');

  before(async () => { gw_ = await spawnHttp([], { CONTEXT_SAVER_TOKEN_TTL_MS: '2000' }); });
  after(() => { try { gw_.stop(); } catch { /* ignore */ } });

  test('unauthenticated /mcp gets 401 with WWW-Authenticate resource_metadata', async () => {
    const res = await postMcp(gw_.base, rpc(1, 'initialize', { protocolVersion: CS.LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    assert.equal(res.status, 401);
    const www = res.headers.get('www-authenticate');
    assert.ok(www.includes('Bearer'), www);
    assert.ok(www.includes(`resource_metadata="${gw_.base}/.well-known/oauth-protected-resource"`), www);
  });

  test('protected-resource + authorization-server metadata are served with CORS', async () => {
    const prm = await fetch(`${gw_.base}/.well-known/oauth-protected-resource`);
    assert.equal(prm.status, 200);
    assert.equal(prm.headers.get('access-control-allow-origin'), '*');
    const prmBody = await prm.json();
    assert.equal(prmBody.resource, gw_.base);
    assert.deepEqual(prmBody.authorization_servers, [gw_.base]);

    const asm = await fetch(`${gw_.base}/.well-known/oauth-authorization-server`);
    const meta = await asm.json();
    assert.equal(meta.issuer, gw_.base);
    assert.equal(meta.authorization_endpoint, `${gw_.base}/authorize`);
    assert.equal(meta.token_endpoint, `${gw_.base}/token`);
    assert.deepEqual(meta.response_types_supported, ['code']);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(meta.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.equal(meta.authorization_response_iss_parameter_supported, true);
  });

  test('dynamic client registration validates redirect URIs', async () => {
    const bad = await fetch(`${gw_.base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'evil', redirect_uris: ['http://remote.example.com/cb'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_redirect_uri');

    const noRedirect = await fetch(`${gw_.base}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x' }),
    });
    assert.equal(noRedirect.status, 400);

    const good = await fetch(`${gw_.base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'http-test-client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(good.status, 201);
    const reg = await good.json();
    assert.ok(reg.client_id.startsWith('cscl_'));
    clientId = reg.client_id;
  });

  test('authorize GET renders the approval page; POST approve redirects with code+state+iss', async () => {
    const url = `${gw_.base}/authorize?${new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te', scope: 'mcp',
    })}`;
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('http-test-client'));
    assert.ok(html.includes('Approve'));

    const decision = await fetch(`${gw_.base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'approve', client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        code_challenge: challenge, code_challenge_method: 'S256', state: 'st4te', scope: 'mcp',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(decision.status, 302);
    const loc = decision.headers.get('location');
    const parsed = new URL(loc);
    assert.equal(parsed.origin + parsed.pathname, redirectUri);
    assert.ok(parsed.searchParams.get('code'));
    assert.equal(parsed.searchParams.get('state'), 'st4te');
    assert.equal(parsed.searchParams.get('iss'), gw_.base);
    authCode = codeFrom(loc);
  });

  test('token endpoint: PKCE verified, single-use codes, refresh rotation', async () => {
    const tokenReq = (form) => fetch(`${gw_.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    // wrong verifier
    const wrong = await tokenReq({ grant_type: 'authorization_code', code: authCode, code_verifier: 'x'.repeat(43), redirect_uri: redirectUri, client_id: clientId });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, 'invalid_grant');

    // right verifier
    const ok = await tokenReq({ grant_type: 'authorization_code', code: authCode, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId });
    assert.equal(ok.status, 200);
    const tok = await ok.json();
    assert.ok(tok.access_token.startsWith('csat_'));
    assert.equal(tok.token_type, 'Bearer');
    assert.ok(tok.refresh_token.startsWith('csrt_'));
    assert.equal(tok.scope, 'mcp');
    accessToken = tok.access_token;
    refreshToken = tok.refresh_token;

    // code reuse is rejected
    const reuse = await tokenReq({ grant_type: 'authorization_code', code: authCode, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId });
    assert.equal(reuse.status, 400);

    // refresh rotation
    const refreshed = await tokenReq({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    assert.equal(refreshed.status, 200);
    const tok2 = await refreshed.json();
    assert.ok(tok2.access_token);
    const rotateAgain = await tokenReq({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    assert.equal(rotateAgain.status, 400, 'old refresh token must be invalidated');
    accessToken = tok2.access_token;
    refreshToken = tok2.refresh_token;
  });

  test('deny flow redirects with error=access_denied', async () => {
    const deny = await fetch(`${gw_.base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'deny', client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        code_challenge: challenge, code_challenge_method: 'S256', state: 'nope',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(deny.status, 302);
    assert.ok(deny.headers.get('location').includes('error=access_denied'));
  });

  test('authorized /mcp access: initialize + full tool round trip', async () => {
    const auth = { authorization: `Bearer ${accessToken}` };
    const init = await postMcp(gw_.base, rpc(20, 'initialize', { protocolVersion: CS.LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'oauth-client', version: '1' } }), auth);
    assert.equal(init.status, 200);
    sessionId = init.headers.get('mcp-session-id');
    const list = await postMcp(gw_.base, rpc(21, 'tools/list', {}), { ...auth, 'mcp-session-id': sessionId });
    assert.equal((await list.json()).result.tools.length, 6);
    const res = await postMcp(gw_.base, rpc(22, 'tools/call', { name: 'cs_call', arguments: { tool: 'demo-calc__add', args: { a: 1, b: 1 } } }), { ...auth, 'mcp-session-id': sessionId });
    assert.equal((await res.json()).result.content[0].text, '2');
  });

  test('garbage tokens are rejected; expired tokens are rejected and refresh still works', async () => {
    const bad = await postMcp(gw_.base, rpc(23, 'tools/list', {}), { authorization: 'Bearer csat_nope', 'mcp-session-id': sessionId });
    assert.equal(bad.status, 401);
    assert.ok(bad.headers.get('www-authenticate').includes('invalid_token'));

    await sleep(2_300); // token TTL is 2s on this gateway
    const expired = await postMcp(gw_.base, rpc(24, 'tools/list', {}), { authorization: `Bearer ${accessToken}`, 'mcp-session-id': sessionId });
    assert.equal(expired.status, 401);

    const refreshed = await fetch(`${gw_.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
    });
    assert.equal(refreshed.status, 200);
    accessToken = (await refreshed.json()).access_token;
    const okAgain = await postMcp(gw_.base, rpc(25, 'tools/list', {}), { authorization: `Bearer ${accessToken}`, 'mcp-session-id': sessionId });
    assert.equal(okAgain.status, 200);
  });

  test('token endpoint is rate-limited (50 requests / 15 min)', async () => {
    let saw429 = false;
    for (let i = 0; i < 60 && !saw429; i++) {
      const res = await fetch(`${gw_.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=authorization_code&code=x&code_verifier=x&client_id=x',
      });
      if (res.status === 429) saw429 = true;
    }
    assert.equal(saw429, true, 'expected the token endpoint to rate-limit eventually');
  });
});
