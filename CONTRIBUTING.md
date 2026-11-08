# Contributing to Context-Saver

Thanks for helping! The bar is intentionally high and the process is
intentionally boring — that's what keeps a single-file gateway trustworthy.

## 60-second dev setup

```bash
git clone https://github.com/renniyy/context-saver && cd context-saver
npm install          # dev-only: ESLint. The product itself has zero deps.
npm test             # 92 tests: unit + stdio E2E + HTTP/OAuth + audit probes (2 audit rounds)
npm run lint         # must report 0 problems
node context-saver.mjs --doctor   # end-to-end self-diagnostic
node context-saver.mjs --demo --client   # play with it interactively
```

No build step. No watcher. `context-saver.mjs` **is** the product.

## The code map

Everything lives in [`context-saver.mjs`](context-saver.mjs) behind a section
index — search for the marker to jump:

| Marker | Section | What lives there |
|---|---|---|
| `[01]` | constants & environment | versions, limits, env knobs |
| `[02]` | utilities | logging, token estimate, globs, PKCE, JSON-RPC |
| `[03]` | configuration | load/validate/expand `${ENV}` |
| `[04]` | catalog cache | disk persistence, atomic writes |
| `[05]` | downstream connections | stdio / streamable HTTP / legacy SSE clients |
| `[06]` | downstream manager | lazy connect, dedup, restart, idle reap |
| `[07]` | planner | task → toolset scoring |
| `[08]` | session + engine + meta-tools | the six `cs_*` tools |
| `[09]` | stdio transport | framing, write mutex |
| `[10]` | HTTP transport | /mcp POST/GET/DELETE, legacy /sse, sweeps |
| `[11]` | OAuth 2.1 provider | DCR, PKCE, approval page, tokens |
| `[12]` | demo servers | the built-in fleet (also test fixtures) |
| `[13]` | REPL client | `--client` |
| `[14]` | doctor | self-diagnostic |
| `[15]` | CLI | argument parsing, entry point |
| `[16]` | exports | what tests import |

Tests: `test/unit.test.mjs` (pure functions), `test/gateway.test.mjs`
(real processes over stdio), `test/http-oauth.test.mjs` (real HTTP servers),
`test/audit.test.mjs` (adversarial probes; each named `audit: fix N — …`
section pins a previously-found bug).

## Ground rules

1. **One behavior per PR.** A fix and its regression test land together.
   The audit history is the template: every `fix(audit#N)` commit contains
   both the reproduction and the fix.
2. **The single-file constraint is CI-enforced.** `package-gate` fails if the
   npm tarball grows a second implementation file. Tests, docs, CI and
   community files are exempt — the *product* is one file.
3. **Zero runtime dependencies.** If you need a library, the answer is "write
   the 40 careful lines yourself" (that's how the whole file got here).
   Node built-ins only, Node ≥ 18.17.
4. **Protocol behavior must match the official SDK.** When in doubt, read
   `modelcontextprotocol/typescript-sdk` and match it; cite the file/line in
   your PR description.
5. **Failing test first** for bug fixes — `test/audit.test.mjs` shows the
   pattern. Features need at least one test per spec bullet they claim.
6. **Token discipline:** every new tool description or `tools/list` payload
   growth is context cost. `doctor` fails if the meta-tool list exceeds
   6 kB; keep it that way.
7. **Logging goes to stderr, always.** stdout is a protocol channel.
8. **Secrets never appear in logs** — no tokens, no header values.

## Review bar

PRs are reviewed for: correctness against the MCP spec, failure-mode
behavior (what happens when the downstream crashes / hangs / lies), token
cost, and test coverage of the above. The audit sections in
`test/audit.test.mjs` are the quality bar we hold ourselves to — read a
couple before your first PR.

## Where to start

[`.github/GOOD_FIRST_ISSUES.md`](.github/GOOD_FIRST_ISSUES.md) lists curated,
scoped tasks with exact file/section pointers. Issues labeled `good first
issue` are pre-approved designs — implementation feedback only, no design
debate needed.

## Release flow

Tags (`vX.Y.Z`) trigger the release workflow: full test suite → per-platform
bundles with launchers + SHA256SUMS → GitHub release → npm publish (if the
`NPM_TOKEN` secret is configured). `package.json`, `server.json` and
`CHANGELOG.md` versions must agree — CI checks it on every run.
