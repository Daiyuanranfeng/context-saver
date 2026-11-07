// Unit tests for Context-Saver internals (no processes spawned).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as CS from '../context-saver.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'cs-unit-'));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('token estimation', () => {
  test('estimateTokens is ceil(chars/4) for strings and JSON for objects', () => {
    assert.equal(CS.estimateTokens('abcd'), 1);
    assert.equal(CS.estimateTokens('abcde'), 2);
    assert.equal(CS.estimateTokens({ a: 1 }), Math.ceil(JSON.stringify({ a: 1 }).length / 4));
  });
});

describe('tool name sanitization', () => {
  test('replaces invalid characters and enforces length', () => {
    assert.equal(CS.sanitizeToolName('weird name!'), 'weird_name_');
    assert.equal(CS.sanitizeToolName('a/b\\c d'), 'a_b_c_d');
    assert.equal(CS.sanitizeToolName(''), 'tool');
    assert.equal(CS.sanitizeToolName('x'.repeat(100), 64).length, 64);
    assert.match(CS.sanitizeToolName('anything at all!'), /^[A-Za-z0-9_-]+$/);
  });
});

describe('glob matching', () => {
  test('exact match without wildcard, prefix glob with wildcard', () => {
    assert.equal(CS.matchGlob('add', 'add'), true);
    assert.equal(CS.matchGlob('add', 'multiply'), false);
    assert.equal(CS.matchGlob('demo-*', 'demo-calc'), true);
    assert.equal(CS.matchGlob('demo-*', 'other'), false);
    assert.equal(CS.matchGlob('*', 'anything'), true);
  });
});

describe('tokenizer + planner scoring', () => {
  const catalog = new Map([
    ['demo-calc', { tools: [
      { name: 'add', description: 'Add two numbers and return the sum.' },
      { name: 'multiply', description: 'Multiply two numbers.' },
    ] }],
    ['demo-fs', { tools: [
      { name: 'read_file', description: 'Read a UTF-8 text file from the demo filesystem.' },
      { name: 'list_dir', description: 'List files and folders.' },
    ] }],
  ]);

  test('tokenize drops stopwords, dedupes, lowercases', () => {
    const tokens = CS.tokenize('The the ADD add of to README');
    assert.deepEqual(tokens, ['add', 'readme']);
  });

  test('scoreTools ranks name matches above description matches', () => {
    const scored = CS.scoreTools('add two numbers then read the todo file', catalog);
    assert.ok(scored.length >= 2);
    const ids = scored.map((s) => `${s.server}__${s.def.name}`);
    assert.ok(ids.includes('demo-calc__add'));
    assert.ok(ids.includes('demo-fs__read_file'));
    assert.ok(!ids.includes('demo-fs__list_dir'));
    const add = scored.find((s) => s.def.name === 'add');
    assert.ok(add.reasons.some((r) => r.includes('name')));
  });

  test('scoreTools is deterministic', () => {
    const a = CS.scoreTools('read the file', catalog);
    const b = CS.scoreTools('read the file', catalog);
    assert.deepEqual(a, b);
  });

  test('empty task scores nothing', () => {
    assert.deepEqual(CS.scoreTools('the of and', catalog), []);
  });
});

describe('PKCE (RFC 7636 S256)', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  test('challenge is unpadded base64url of SHA-256 of the verifier', () => {
    const expected = createHash('sha256').update(verifier).digest('base64url').replace(/=+$/, '');
    const got = CS.pkceChallengeFromVerifier(verifier);
    assert.equal(got, expected);
    assert.ok(!got.includes('='));
    assert.ok(!got.includes('+'));
    assert.ok(!got.includes('/'));
  });
  test('verifyPkce accepts the right verifier and rejects wrong/short ones', () => {
    const challenge = CS.pkceChallengeFromVerifier(verifier);
    assert.equal(CS.verifyPkce(verifier, challenge), true);
    assert.equal(CS.verifyPkce('wrong-verifier-wrong-verifier-wrong-verifier', challenge), false);
    assert.equal(CS.verifyPkce('short', challenge), false);
    assert.equal(CS.verifyPkce(verifier, 'deadbeef'), false);
  });
});

describe('JSON-RPC helpers', () => {
  test('shape checks and error encoding', () => {
    assert.equal(CS.isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }), true);
    assert.equal(CS.isJsonRpcRequest({ jsonrpc: '2.0', method: 'ping' }), false);
    assert.equal(CS.isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }), true);
    const err = CS.rpcError('abc', CS.ErrorCode.INVALID_PARAMS, 'nope');
    assert.equal(err.id, 'abc');
    assert.equal(err.error.code, -32602);
  });
});

describe('config loading', () => {
  const file = (obj) => {
    const p = path.join(TMP, `cfg-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return p;
  };

  test('missing config yields empty servers and null path', () => {
    const cfg = CS.loadConfig(path.join(TMP, 'does-not-exist.json'));
    assert.equal(cfg.path, null);
    assert.deepEqual(cfg.servers, {});
  });

  test('accepts both "servers" and Claude-style "mcpServers"', () => {
    const a = CS.loadConfig(file({ servers: { one: { command: 'node', args: ['x'] } } }));
    const b = CS.loadConfig(file({ mcpServers: { one: { command: 'node', args: ['x'] } } }));
    assert.equal(Object.keys(a.servers).length, 1);
    assert.equal(Object.keys(b.servers).length, 1);
    assert.equal(a.servers.one.type, 'stdio');
  });

  test('http url entries become type http; transport=sse becomes legacy-sse', () => {
    const cfg = CS.loadConfig(file({ servers: {
      h: { url: 'https://example.com/mcp' },
      s: { url: 'https://example.com/sse', transport: 'sse' },
    } }));
    assert.equal(cfg.servers.h.type, 'http');
    assert.equal(cfg.servers.s.type, 'legacy-sse');
  });

  test('expands ${VAR} from the environment', () => {
    process.env.CS_UNIT_TOKEN = 'sekret-value';
    try {
      const cfg = CS.loadConfig(file({ servers: { h: { url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${CS_UNIT_TOKEN}' } } } }));
      assert.equal(cfg.servers.h.headers.Authorization, 'Bearer sekret-value');
    } finally {
      delete process.env.CS_UNIT_TOKEN;
    }
  });

  test('invalid entries produce a ConfigError listing every issue', () => {
    let err = null;
    try { CS.loadConfig(file({ servers: { bad: {}, worse: { command: 42 } } })); } catch (e) { err = e; }
    assert.ok(err instanceof CS.ConfigError);
    assert.ok(err.issues.length >= 2);
    assert.ok(err.issues.some((i) => i.includes('bad')));
    assert.ok(err.issues.some((i) => i.includes('worse')));
  });

  test('unparseable config produces ConfigError', () => {
    let err = null;
    try { CS.loadConfig(file('{nope')); } catch (e) { err = e; }
    assert.ok(err instanceof CS.ConfigError);
  });

  test('disabled servers are skipped silently', () => {
    const cfg = CS.loadConfig(file({ servers: { off: { command: 'x', disabled: true }, on: { command: 'node' } } }));
    assert.equal(cfg.servers.off, undefined);
    assert.ok(cfg.servers.on);
  });
});

describe('SSE parser', () => {
  test('parses events delivered in arbitrary chunk boundaries, tolerates CRLF', () => {
    const events = [];
    const parser = new CS.SseParser(({ event, data }) => events.push({ event, data }));
    const wire = 'event: endpoint\r\ndata: /messages?sessionId=abc\r\n\r\n' +
      'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\r\n\r\n' +
      ': keepalive\n\n' +
      'data: line one\ndata: line two\n\n';
    for (const chunk of wire.match(/[\s\S]{1,7}/g)) parser.push(chunk);
    assert.deepEqual(events, [
      { event: 'endpoint', data: '/messages?sessionId=abc' },
      { event: 'message', data: '{"jsonrpc":"2.0","id":1,"result":{}}' },
      { event: 'message', data: 'line one\nline two' },
    ]);
  });
});

describe('pattern resolution (cs_load)', () => {
  const catalog = new Map([
    ['demo-calc', { tools: [{ name: 'add' }, { name: 'multiply' }] }],
    ['demo-fs', { tools: [{ name: 'read_file' }, { name: 'list_dir' }] }],
  ]);

  test('exact id, bare tool name, and server glob all resolve', () => {
    const { matches } = CS.resolvePatterns(['demo-calc__add', 'read_file', 'demo-fs:*'], catalog);
    assert.deepEqual(matches.map((m) => m.key).sort(), ['demo-calc__add', 'demo-fs__list_dir', 'demo-fs__read_file']);
  });

  test('misses come back with suggestions', () => {
    const { matches, misses } = CS.resolvePatterns(['demo-calc__addd', 'nope-server:*'], catalog);
    assert.equal(matches.length, 0);
    assert.equal(misses.length, 2);
    assert.ok(misses[0].hint.includes('demo-calc__add'), misses[0].hint);
    assert.ok(misses[1].hint.includes('no configured server'));
  });

  test('duplicate patterns collapse', () => {
    const { matches } = CS.resolvePatterns(['demo-calc__add', 'add', 'demo-calc:add'], catalog);
    assert.equal(matches.length, 1);
  });
});

describe('catalog cache', () => {
  test('save/load roundtrip preserves fingerprints; corrupt files are quarantined', () => {
    const dir = path.join(TMP, 'cache');
    const cache = new CS.CatalogCache(dir);
    cache.save(new Map([
      ['srv', { tools: [{ name: 't1', description: 'd' }], fetchedAt: 123, fingerprint: 'abc123' }],
    ]));
    const loaded = cache.load();
    assert.equal(loaded.get('srv').fingerprint, 'abc123');
    assert.equal(loaded.get('srv').tools[0].name, 't1');

    writeFileSync(path.join(dir, 'catalog-cache.json'), '{corrupt json');
    const cache2 = new CS.CatalogCache(dir);
    const loaded2 = cache2.load();
    assert.equal(loaded2.size, 0);
    assert.ok(existsSync(path.join(dir, 'catalog-cache.json.corrupt')));
  });

  test('manager fingerprint changes when the server spec changes', () => {
    const servers = () => ({ a: { name: 'a', type: 'stdio', command: 'node', args: ['x'] } });
    const m1 = new CS.DownstreamManager({ useCache: false, servers: servers() });
    const fp1 = m1._fingerprint('a');
    const m2 = new CS.DownstreamManager({ useCache: false, servers: servers() });
    assert.equal(fp1, m2._fingerprint('a'), 'same spec must fingerprint identically');
    m1.servers.a = { name: 'a', type: 'stdio', command: 'node', args: ['y'] };
    assert.notEqual(fp1, m1._fingerprint('a'), 'changed spec must change the fingerprint');
    assert.equal(m1._fingerprint('missing'), 'none');
  });
});

describe('tools/list pagination', () => {
  test('cursor pages through meta tools and rejects garbage cursors', async () => {
    const manager = new CS.DownstreamManager({ useCache: false });
    const engine = new CS.GatewayEngine({ manager });
    const session = engine.createSession('unit');
    process.env.CONTEXT_SAVER_PAGE_SIZE = '4';
    try {
      const seen = [];
      let cursor;
      let guard = 0;
      do {
        const page = await engine._toolsList({ params: cursor ? { cursor } : {} }, session);
        seen.push(...page.tools.map((t) => t.name));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 10);
      assert.equal(seen.length, 6);
      assert.deepEqual(new Set(seen).size, 6);

      await assert.rejects(
        () => engine._toolsList({ params: { cursor: '!!!not-base64!!!' } }, session),
        (err) => err.rpcCode === CS.ErrorCode.INVALID_PARAMS,
      );
    } finally {
      delete process.env.CONTEXT_SAVER_PAGE_SIZE;
    }
  });
});

describe('initialize negotiation', () => {
  test('supported versions echo; unsupported versions get the latest counter-offer', async () => {
    const manager = new CS.DownstreamManager({ useCache: false });
    const engine = new CS.GatewayEngine({ manager });
    const session = engine.createSession('unit');
    const { reply } = await engine.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, session);
    assert.equal(reply.result.protocolVersion, '2024-11-05');
    assert.equal(reply.result.capabilities.tools.listChanged, true);
    assert.ok(reply.result.instructions.length > 50);
    const { reply: reply2 } = await engine.handleRequest({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, session);
    assert.equal(reply2.result.protocolVersion, CS.LATEST_PROTOCOL_VERSION);
  });
});
