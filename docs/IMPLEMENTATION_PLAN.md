# Implementation Plan — Context-Saver 1.0.0

> Status: **executed**. This document is the plan that was written *before* any
> implementation code existed, preserved so contributors can understand the
> architecture in the order it was designed.

## 0. Problem statement

Connecting many MCP servers to one client burns 15k–20k+ tokens of tool schemas
per session before the user types a single word, and encourages the model to
hallucinate multi-server workflows it can barely see. Context-Saver replaces
N direct connections with one gateway connection whose *fixed* footprint is
~1.1k tokens (6 meta-tools); downstream schemas enter the context only when a
specific turn needs them.

## 1. Research inputs

- `modelcontextprotocol/typescript-sdk` (v2 monorepo): extracted exact protocol
  facts — version list (`2024-10-07` … `2025-11-25`), initialize negotiation,
  tools/list + tools/call wire shapes, `notifications/tools/list_changed`,
  stdio newline-JSON framing (skip unparseable lines, 10 MB cap), Streamable
  HTTP rules (406/415/413/400 matrix, `mcp-session-id`, `MCP-Protocol-Version`,
  `event: message` SSE frames, `: keepalive` every 15 s, 202 for notifications,
  404 `-32001` unknown session), legacy SSE `event: endpoint` handshake, OAuth
  discovery (path-aware `/.well-known/oauth-protected-resource`), PKCE S256,
  RFC 7591 dynamic registration, form-encoded token endpoint.
- OSS pattern survey (browser-use, Scrapling, rea, Agent-Reach,
  changedetection.io, skills, ponytail, craft-anything): registry `server.json`,
  `<!-- mcp-name -->` README marker, package-gate CI asserting single-file
  tarball, version-consistency checks, label-scoped triage automation,
  SCOPE/out-of-scope precedent, benchmark-with-methodology, `llms.txt`,
  per-agent install tabs, defensive annotations/budgets.

## 2. Architecture

Everything ships in **one file** (`context-saver.mjs`, zero runtime deps,
Node ≥ 18.17). Logical layers:

```
CLI (args, --doctor, --demo, --client)
  └─ Transports: stdio | Streamable HTTP (+ legacy /sse)  ── OAuth 2.1 middleware
        └─ Engine: JSON-RPC 2.0 router, initialize negotiation, pagination, ping
              └─ Session manager: loaded-toolsets, token accounting, TTL sweeps
                    ├─ Meta-tools (6, fixed): discover / plan / load / unload / status / call
                    └─ Downstream manager: stdio+HTTP clients, lazy connect,
                       dedup, restart, idle reap, disk catalog cache
```

### Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Zero dependencies, single file | Copy-paste virality; no supply-chain risk; `npx` install is 1 file; trivial multi-platform releases |
| D2 | Loaded tools surface natively via `notifications/tools/list_changed` | Spec-compliant; clients re-fetch `tools/list` and expose them as normal tools; `cs_call` remains as an explicit fallback for clients that ignore the notification |
| D3 | Catalog cached on disk (`~/.context-saver/catalog-cache.json`) | `cs_discover` works instantly after restart without connecting to any downstream server |
| D4 | `cs_plan` is a deterministic scorer, not an LLM | The gateway must stay free, offline, and unbiased; scoring is explainable and testable |
| E5 | Tool exec failures are `isError:true` results, protocol failures are JSON-RPC errors | Matches SDK/spec semantics; keeps agent loops alive |
| D6 | OAuth 2.1 AS embedded (DCR + PKCE + approval pop-up) | "Zero-auth friction" remote URL story; satisfies the official SDK client's discovery/parsing behavior |
| D7 | Non-localhost bind refuses to start without `--auth` | Safe-by-default remote exposure |
| D8 | Demo fleet built into the same file, self-spawned | `--demo` gives a working 3-server/13-tool setup with zero config; doubles as test fixture |

### Token accounting model

`estimateTokens(x) = ceil(JSON.stringify(x).length / 4)` (documented as an
estimate). Baseline = sum over all catalog tools; session cost = meta-tools +
loaded tool definitions; savings = baseline − session cost. Reported live by
`cs_status` and the `--client` REPL.

## 3. Milestones

- **M1 Protocol core** — JSON-RPC framing/parse, engine, initialize
  negotiation, tools/list pagination, ping, error codes. *Acceptance:* handshake
  round-trip against a raw JSON-RPC client.
- **M2 Downstream manager** — stdio + HTTP connections, lazy connect, dedup,
  timeouts, restart, catalog + cache. *Acceptance:* multiplex 3 demo servers.
- **M3 Meta-tools** — discover/plan/load/unload/status/call + list_changed.
  *Acceptance:* load → tools appear → call → result routed to owner.
- **M4 HTTP + OAuth** — Streamable HTTP, legacy SSE, session TTLs, OAuth AS.
  *Acceptance:* curl-level OAuth dance; SDK-shape WWW-Authenticate headers.
- **M5 DX** — demo fleet, `--client` REPL, `--doctor`, config loader.
- **M6 Hardening** — audit phase (§5).

## 4. Test plan (mapped to the product spec)

| Spec requirement | Tests |
|---|---|
| Gateway replaces N connections | `gateway: fixed meta-tool footprint`, `gateway: measured token savings` |
| Lazy loading | `gateway: cs_load exposes tools + list_changed`, `gateway: schemas only after load`, `gateway: cs_call auto-load` |
| Prompt inspection | `unit: planner ranks relevant tools`, `gateway: cs_plan end-to-end` |
| Multi-server multiplexing | `gateway: routes calls to owning server`, `gateway: 3 servers, 16 tools` |
| Robustness | downstream error/crash/timeout/restart, malformed frames, CRLF, concurrent calls |
| stdio transport | handshake, pagination, parse-error handling |
| Streamable HTTP | session lifecycle, 406/415/404 matrix, SSE responses, DELETE, keepalive |
| Legacy SSE | `endpoint` event, POST/202, message via stream |
| OAuth | 401 + WWW-Authenticate, discovery docs, DCR, PKCE verify, token + refresh, expiry, protected calls |
| Config | `servers`/`mcpServers` alias, env expansion, validation errors |
| DevOps claims | `doctor` exits 0; package-gate asserts 1-file tarball (CI) |

## 5. Audit protocol

1. Enumerate bugs / dead files / missing tests / risky patterns.
2. Rank by P(bites a real user) × blast radius; skip "just unusual" items.
3. For each of the top 5: write the failing test (or capture the log/repro),
   fix, land as exactly one commit, re-verify.
4. Report the full ranked list, what was fixed, and what was deliberately left.

## 6. Deliverables

`context-saver.mjs`, `test/` (3 suites), `README.md` (Mermaid + SVG + GIF +
quick start + benchmark), `docs/architecture.svg`, `.github/workflows/ci.yml`
+ `release.yml` + triage automation, community pipeline
(GOOD_FIRST_ISSUES.md, SCOPE.md, issue forms, CONTRIBUTING, SECURITY,
AGENTS.md), `server.json`, `llms.txt`, Dockerfile.
