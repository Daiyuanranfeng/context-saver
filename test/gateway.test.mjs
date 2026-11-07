// End-to-end tests: real gateway processes over stdio JSON-RPC, real demo
// downstream servers spawned as child processes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync , realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as CS from '../context-saver.mjs';

const SELF = realpathSync(fileURLToPath(new URL('../context-saver.mjs', import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), 'cs-e2e-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const gw = (extraArgs = [], env = {}) => CS.SimpleMcpClient.spawn(['--demo', ...extraArgs], { env });
const call = (client, name, args) => client.request('tools/call', { name, arguments: args });
const textOf = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';

const waitForNotification = (client, method, timeoutMs = 5_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
  const prev = client.onNotification;
  client.onNotification = (msg) => {
    if (msg.method === method) {
      clearTimeout(timer);
      client.onNotification = prev;
      resolve(msg);
    } else prev?.(msg);
  };
});

const rawExchange = (client, line, timeoutMs = 5_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no raw response')), timeoutMs);
  client.onUnhandledMessage = (msg) => {
    clearTimeout(timer);
    client.onUnhandledMessage = null;
    resolve(msg);
  };
  client.child.stdin.write(`${line}\n`);
});

const customConfig = (servers) => {
  const p = path.join(TMP, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ servers }));
  return p;
};
const demoServer = (name, extra = {}) => ({
  command: process.execPath, args: [SELF, '--demo-server', name], ...extra,
});

describe('gateway happy path (one gateway, one session)', () => {
  const client = gw();
  after(() => client.close());

  test('initialize handshake advertises listChanged and instructions', async () => {
    const init = await client.initialize('e2e');
    assert.equal(init.serverInfo.name, 'context-saver');
    assert.equal(init.capabilities.tools.listChanged, true);
    assert.ok(init.instructions.includes('cs_discover'));
    assert.ok(CS.SUPPORTED_PROTOCOL_VERSIONS.includes(init.protocolVersion));
    client.notify('notifications/initialized');
  });

  test('ping answers {}', async () => {
    const res = await client.request('ping');
    assert.deepEqual(res.result, {});
  });

  test('initial tools/list is exactly the 6 meta-tools and stays tiny', async () => {
    const res = await client.request('tools/list');
    const tools = res.result.tools;
    assert.equal(tools.length, 6);
    assert.deepEqual(tools.map((t) => t.name).sort(), ['cs_call', 'cs_discover', 'cs_load', 'cs_plan', 'cs_status', 'cs_unload']);
    assert.equal(res.result.nextCursor, undefined);
    const bytes = JSON.stringify(tools).length;
    assert.ok(bytes < 6000, `meta-tool list is ${bytes} bytes`);
  });

  test('cs_discover aggregates the 3 demo servers (16 tools) without schemas', async () => {
    const res = await call(client, 'cs_discover', {});
    const text = textOf(res);
    assert.ok(text.includes('16 tool(s) across 3 server(s)'));
    assert.ok(text.includes('demo-calc__add'));
    assert.ok(text.includes('demo-chaos__echo'));
    assert.ok(text.includes('[≈'));
    assert.ok(!text.includes('inputSchema'), 'discover must not leak schemas');
  });

  test('cs_discover filters by query', async () => {
    const res = await call(client, 'cs_discover', { query: 'table' });
    const text = textOf(res);
    assert.ok(text.includes('demo-calc__format_table'), text);
    assert.ok(!text.includes('demo-calc__add'), text);
    const res2 = await call(client, 'cs_discover', { query: 'report' });
    assert.ok(textOf(res2).includes('demo-calc__format_report'));
  });

  test('cs_plan recommends the minimal toolset for a task', async () => {
    const res = await call(client, 'cs_plan', { task: 'add two numbers then read the todo file' });
    const text = textOf(res);
    assert.ok(text.includes('demo-calc__add'), text);
    assert.ok(text.includes('demo-fs__read_file'), text);
    assert.ok(text.includes('cs_load'));
    assert.ok(res.result.structuredContent.recommended.length >= 2);
  });

  test('cs_load returns the schema, emits list_changed, and the tool becomes callable', async () => {
    const notifPromise = waitForNotification(client, 'notifications/tools/list_changed');
    const res = await call(client, 'cs_load', { tools: ['demo-calc__add'] });
    const text = textOf(res);
    assert.ok(text.includes('Loaded 1 tool(s)'), text);
    assert.ok(text.includes('inputSchema'), 'schema must be echoed in the result');
    assert.ok(text.includes('demo-calc__add'));
    await notifPromise;

    const list = await client.request('tools/list');
    assert.equal(list.result.tools.length, 7);
    const add = list.result.tools.find((t) => t.name === 'demo-calc__add');
    assert.ok(add, 'loaded tool missing from tools/list');
    assert.deepEqual(add.inputSchema.required, ['a', 'b']);
    assert.ok(add.description.includes('(via demo-calc)'));
  });

  test('direct tools/call routes through the gateway to the downstream server', async () => {
    const res = await call(client, 'demo-calc__add', { a: 40, b: 2 });
    assert.equal(textOf(res), '42');
    assert.equal(res.result.structuredContent.result, 42);
    assert.notEqual(res.result.isError, true);
  });

  test('cs_call auto-routes without loading the schema first', async () => {
    const res = await call(client, 'cs_call', { tool: 'demo-fs__read_file', args: { path: 'notes/todo.md' } });
    const text = textOf(res);
    assert.ok(text.includes('connect one gateway'), text);
  });

  test('cs_status reports live token savings', async () => {
    const res = await call(client, 'cs_status', {});
    const sc = res.result.structuredContent;
    assert.ok(sc.tokens.savedTokens > 0);
    assert.ok(sc.tokens.savedPct > 0);
    assert.equal(sc.tokens.loadedCount, 1);
    assert.ok(Array.isArray(sc.servers) && sc.servers.length === 3);
  });

  test('cs_unload reclaims context and re-emits list_changed', async () => {
    const notifPromise = waitForNotification(client, 'notifications/tools/list_changed');
    const res = await call(client, 'cs_unload', {});
    assert.ok(textOf(res).includes('Unloaded 1 tool(s)'));
    await notifPromise;
    const list = await client.request('tools/list');
    assert.equal(list.result.tools.length, 6);
  });
});

describe('error paths and protocol behavior', () => {
  const client = gw();
  after(() => client.close());
  before(async () => { await client.initialize('e2e-err'); });

  test('unknown tool name yields -32602 with guidance', async () => {
    const res = await call(client, 'no_such_tool', {});
    assert.equal(res.error.code, -32602);
    assert.ok(res.error.message.includes('cs_discover'));
  });

  test('tools/call with non-object arguments yields -32602', async () => {
    const res = await client.request('tools/call', { name: 'cs_plan', arguments: 'nope' });
    assert.equal(res.error.code, -32602);
  });

  test('unknown method yields -32601; unimplemented features answer empty lists', async () => {
    assert.equal((await client.request('resources/list')).result.resources.length, 0);
    assert.equal((await client.request('prompts/list')).result.prompts.length, 0);
    assert.equal((await client.request('wombats/parade')).error.code, -32601);
  });

  test('cs_plan/cs_load/cs_call validate their inputs', async () => {
    assert.equal((await call(client, 'cs_plan', {})).error.code, -32602);
    assert.equal((await call(client, 'cs_load', { tools: 'add' })).error.code, -32602);
    assert.equal((await call(client, 'cs_load', { tools: [] })).error.code, -32602);
    assert.equal((await call(client, 'cs_call', {})).error.code, -32602);
    assert.equal((await call(client, 'cs_call', { tool: 'x', args: [] })).error.code, -32602);
  });

  test('cs_call with an unknown tool suggests close matches', async () => {
    await call(client, 'cs_discover', {});
    const res = await call(client, 'cs_call', { tool: 'demo-calc__addd' });
    assert.equal(res.error.code, -32602);
    assert.ok(res.error.message.includes('demo-calc__add'), res.error.message);
  });

  test('cs_load reports misses instead of failing', async () => {
    const res = await call(client, 'cs_load', { tools: ['zzz:nope'] });
    const text = textOf(res);
    assert.ok(text.includes('Loaded nothing'));
    assert.ok(text.includes('no configured server'));
  });

  test('malformed JSON on stdio answers -32700 without dying', async () => {
    const msg = await rawExchange(client, 'this is not json');
    assert.equal(msg.error.code, -32700);
    assert.equal(msg.id, null);
  });

  test('string request ids round-trip; blank lines and CRLF frames are tolerated', async () => {
    const msg = await rawExchange(client, '{"jsonrpc":"2.0","id":"string-id-1","method":"ping"}');
    assert.equal(msg.id, 'string-id-1');
    assert.deepEqual(msg.result, {});
    client.child.stdin.write('\n');
    client.child.stdin.write('{"jsonrpc":"2.0","id":"crlf-1","method":"ping"}\r\n');
    const msg2 = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3_000);
      client.onUnhandledMessage = (m) => { if (m.id === 'crlf-1') { clearTimeout(timer); resolve(m); } };
    });
    assert.deepEqual(msg2?.result, {});
    client.onUnhandledMessage = null;
  });

  test('cancellation notifications for unknown requests are harmless', async () => {
    client.notify('notifications/cancelled', { requestId: 999999, reason: 'test' });
    const res = await client.request('ping');
    assert.deepEqual(res.result, {});
  });
});

describe('downstream failure modes (custom config)', () => {
  test('tool errors, JSON-RPC errors, crashes, timeouts and unreachables all degrade gracefully', async () => {
    const cfg = customConfig({
      'demo-fs': demoServer('demo-fs'),
      'demo-calc': demoServer('demo-calc'),
      'demo-chaos': demoServer('demo-chaos', { timeoutMs: 600 }),
      broken: { command: 'definitely-not-a-real-binary-xyz' },
    });
    const client = CS.SimpleMcpClient.spawn(['--config', cfg]);
    try {
      await client.initialize('e2e-fail');
      await call(client, 'cs_load', { tools: ['demo-chaos:echo', 'demo-chaos:fail'] });

      const err = await call(client, 'demo-chaos__fail', { mode: 'error' });
      assert.equal(err.result.isError, true);
      assert.ok(textOf(err).includes('requested failure'));

      const rpc = await call(client, 'demo-chaos__fail', { mode: 'rpc' });
      assert.equal(rpc.error.code, -32602);
      assert.ok(rpc.error.message.includes('chaos'));

      const crash = await call(client, 'demo-chaos__fail', { mode: 'crash' });
      assert.equal(crash.result.isError, true);
      assert.ok(textOf(crash).includes('exited during the call'));

      const revived = await call(client, 'demo-chaos__echo', { message: 'phoenix' });
      assert.equal(textOf(revived), 'phoenix');

      const t0 = Date.now();
      const slow = await call(client, 'cs_call', { tool: 'demo-chaos__slow', args: { seconds: 5 } });
      const elapsed = Date.now() - t0;
      assert.equal(slow.result.isError, true);
      assert.ok(textOf(slow).includes('timed out'), textOf(slow));
      assert.ok(elapsed < 4_000, `timeout took ${elapsed}ms`);
      assert.ok(textOf(slow).includes('Hint'));

      const unreachable = await call(client, 'cs_call', { tool: 'broken__whatever', args: {} });
      assert.equal(unreachable.result.isError, true);
      assert.ok(textOf(unreachable).includes('cannot connect'), textOf(unreachable));
    } finally {
      client.close();
    }
  });
});

describe('pagination, globs and name sanitization', () => {
  test('cursor pagination walks the whole list; globs load whole servers; bad names get sanitized', async () => {
    const client = gw([], { CONTEXT_SAVER_PAGE_SIZE: '4' });
    try {
      await client.initialize('e2e-page');
      const seen = [];
      let cursor;
      let pages = 0;
      do {
        const res = await client.request('tools/list', cursor ? { cursor } : {});
        seen.push(...res.result.tools.map((t) => t.name));
        cursor = res.result.nextCursor;
        pages += 1;
      } while (cursor);
      assert.equal(seen.length, 6);
      assert.equal(pages, 2);

      await call(client, 'cs_load', { tools: ['demo-chaos:*'] });
      const allTools = [];
      let listCursor;
      do {
        const list = await client.request('tools/list', listCursor ? { cursor: listCursor } : {});
        allTools.push(...list.result.tools);
        listCursor = list.result.nextCursor;
      } while (listCursor);
      // 6 meta + 4 chaos tools (incl. the sanitized "weird name!")
      assert.equal(allTools.length, 10);
      for (const t of allTools) assert.match(t.name, /^[A-Za-z0-9_-]{1,64}$/);
      assert.ok(allTools.some((t) => t.name === 'demo-chaos__weird_name_'));
      assert.ok(!allTools.some((t) => t.name.includes('!')));

      const res = await call(client, 'demo-chaos__weird_name_', { note: 'hi' });
      assert.equal(textOf(res), 'sanitized-name round trip OK');

      const unload = await call(client, 'cs_unload', { tools: ['demo-chaos:weird*'] });
      assert.ok(textOf(unload).includes('Unloaded 1 tool(s)'));
      const afterTools = [];
      let afterCursor;
      do {
        const after = await client.request('tools/list', afterCursor ? { cursor: afterCursor } : {});
        afterTools.push(...after.result.tools);
        afterCursor = after.result.nextCursor;
      } while (afterCursor);
      assert.equal(afterTools.length, 9);
    } finally {
      client.close();
    }
  });
});

describe('concurrency', () => {
  test('25 parallel calls stay correctly correlated; parallel discovery dedups connects', async () => {
    const client = gw();
    try {
      await client.initialize('e2e-conc');
      await Promise.all(Array.from({ length: 5 }, () => call(client, 'cs_discover', {})));
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
        call(client, 'cs_call', { tool: 'demo-chaos__echo', args: { message: `msg-${i}` } })));
      for (const [i, res] of results.entries()) {
        assert.equal(textOf(res), `msg-${i}`);
      }
      const status = await call(client, 'cs_status', {});
      assert.equal(status.result.structuredContent.manager.calls, 25);
    } finally {
      client.close();
    }
  });
});

describe('catalog cache across restarts', () => {
  test('second gateway serves discovery from disk cache; config change invalidates it', async () => {
    const cacheDir = path.join(TMP, 'cache-a');
    const cfg = customConfig({
      'demo-fs': demoServer('demo-fs'),
      'demo-calc': demoServer('demo-calc'),
    });
    const env = { CONTEXT_SAVER_CACHE_DIR: cacheDir, CONTEXT_SAVER_LOG: 'silent' };

    const first = CS.SimpleMcpClient.spawn(['--config', cfg], env);
    try {
      await first.initialize('cache-1');
      const disc = await call(first, 'cs_discover', {});
      assert.ok(textOf(disc).includes('12 tool(s) across 2 server(s)'));
    } finally { first.close(); }

    const second = CS.SimpleMcpClient.spawn(['--config', cfg], env);
    try {
      await second.initialize('cache-2');
      const disc = await call(second, 'cs_discover', {});
      assert.ok(textOf(disc).includes('12 tool(s)'), 'cached catalog should serve discovery without reconnecting');
      assert.ok(textOf(disc).includes('disk cache'));
      const status = await call(second, 'cs_status', {});
      for (const s of status.result.structuredContent.servers) {
        assert.equal(s.state, 'disconnected', 'cache hit must not connect');
      }
    } finally { second.close(); }

    // fingerprint invalidation: same server name, different args -> fresh fetch
    const cfg2 = customConfig({
      'demo-fs': demoServer('demo-fs', { env: { X: '1' } }),
      'demo-calc': demoServer('demo-calc'),
    });
    const third = CS.SimpleMcpClient.spawn(['--config', cfg2], env);
    try {
      await third.initialize('cache-3');
      const status = await call(third, 'cs_status', {});
      const fs = status.result.structuredContent.servers.find((s) => s.name === 'demo-fs');
      assert.equal(fs.state, 'connected', 'changed spec must invalidate the cache entry');
    } finally { third.close(); }
  });
});

describe('zombie prevention', () => {
  test('SIGTERM to the gateway kills its downstream children', async () => {
    const client = gw();
    await client.initialize('e2e-zombie');
    await call(client, 'cs_load', { tools: ['demo-calc__add'] });
    const status = await call(client, 'cs_status', {});
    const pids = status.result.structuredContent.servers.map((s) => s.pid).filter(Boolean);
    assert.ok(pids.length >= 1, 'expected at least one live downstream pid');
    const alive = (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    for (const pid of pids) assert.ok(alive(pid));
    client.child.kill('SIGTERM');
    await new Promise((resolve) => client.child.on('exit', resolve));
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of pids) assert.equal(alive(pid), false, `downstream pid ${pid} survived gateway shutdown`);
  });
});
