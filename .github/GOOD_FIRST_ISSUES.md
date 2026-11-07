# 🌱 Good First Issues — the contribution pipeline

Every item below is **pre-scoped**: you get the exact file/section to touch,
the acceptance test to make pass, and an estimate. Issues labeled
[`good first issue`](https://github.com/context-saver/context-saver/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
mirror this list — claim one by commenting `/attempt` and mentioning your
branch.

> New to the codebase? The whole product is
> [`context-saver.mjs`](../context-saver.mjs) with a `[01]`–`[16]` section
> index at the top. CONTRIBUTING.md has the 60-second setup.

## 🟢 Starter (an afternoon)

### 1. Prompts & resources pass-through
The gateway multiplexes **tools**; `prompts/list` and `resources/list`
currently return empty lists (spec-allowed). Add lazy meta-tools mirroring
the tools pattern: `cs_list_prompts` / `cs_list_resources` +
`cs_get_prompt` / `cs_read_resource`.
- Where: engine `[08]` — copy the `hDiscover`/`hCall` shapes; capabilities in
  `_initialize`.
- Acceptance: a demo server exposing one prompt + one resource, a test in
  `test/gateway.test.mjs` asserting lazy behavior (empty before, present
  after load).

### 2. Test the `--allowed-origin` and `--public-url` flags
Both flags exist (`[15]`, `originAllowed` in `[10]`) but have zero coverage.
- Where: `test/http-oauth.test.mjs` — spawn two extra gateways.
- Acceptance: cross-origin POST rejected with the flag unset, accepted with
  the origin allowlisted; OAuth metadata advertises the `--public-url` base.

### 3. Config `defaults` block coverage
`loadConfig` parses `defaults: { timeoutMs, initTimeoutMs, idleMs }` (`[03]`)
and the manager consumes them (`[06]`) — untested.
- Where: `test/unit.test.mjs` + one E2E case with a slow demo server.
- Acceptance: a default `timeoutMs` provably applies to servers without
  their own value.

### 4. `doctor` check for the catalog cache
`--doctor` doesn't verify the disk cache roundtrip. Add a check: two
sequential doctor runs, the second must serve discovery from cache without
connecting (mirror the `catalog cache across restarts` test).
- Where: `runDoctor` `[14]`.
- Acceptance: new ✔ line; still exits 0.

## 🟡 Intermediate (a weekend)

### 5. Streaming progress passthrough
Forward `notifications/progress` from a downstream call to the client while
a routed `tools/call` is in flight (progressToken plumbing).
- Where: `_callDownstream` + both transports.
- Acceptance: a demo-chaos tool that emits progress; client receives it.

### 6. `notifications/cancelled` aborts in-flight downstream work
Cancellation currently suppresses the reply but doesn't abort the downstream
request (documented limitation; see `audit: fix 1` for the surrounding tests).
Wire an `AbortSignal` through `manager.callTool` into HTTP fetches, and drop
stdio replies on the floor.
- Where: `[06]` + `[05]` + `[08]`.
- Acceptance: cancelled slow tool stops burning downstream CPU (observable
  via process exit of a demo-chaos variant).

### 7. MCP registry publication in the release workflow
`server.json` is ready but releases don't publish to the official registry.
Add the `mcp-publisher` step (SHA-pinned) behind a secret, following the
pattern used by `morluto/rea`.
- Where: `.github/workflows/release.yml`.

## 🔴 Ambitious

### 8. Sampling / elicitation bridging
Let downstream servers request LLM sampling/elicitation *through* the
gateway's client (opt-in per server; off by default — this is a trust
boundary).
- Where: `BaseDownstream` server-request handling + engine + a capability flag.

---

**Claiming:** comment `/attempt` on the tracking issue, then link your PR.
Stuck after 30 minutes? Ask in the issue — pointers come fast.
**Done means:** tests green on all 3 OS (`npm test` locally covers the rest),
lint clean, one behavior per PR, CHANGELOG entry.
