# Scope

What belongs in Context-Saver, with documented precedent for what doesn't.
Reactions and +1s don't count; observed behavior in a real session does.

## In scope

- **Multiplexing** downstream MCP servers behind one connection, with
  lazy tool-schema loading and token accounting — the core.
- Spec conformance with the official TypeScript SDK's client behavior
  (transports, error codes, OAuth discovery).
- Trust features that make remote exposure safe: OAuth, origin validation,
  safe-by-default binds, rate limits.
- The built-in demo fleet, REPL client and doctor — they ARE the docs, the
  tests and the GIF.

## Out of scope (with precedent)

| Proposal | Decision | Why |
|---|---|---|
| Turning the planner into an LLM call | **No** — 2026-11 | The gateway must stay free, offline, deterministic and explainable. A heuristic that ranks 40 tools in microseconds is the right tool; agents that *want* an LLM plan can ask their own model and feed the result to `cs_load`. |
| Caching tool *results* (not just catalogs) | **No** — 2026-11 | Result caching changes tool semantics (staleness by side effect) and belongs in the tool or the agent, not the router. |
| A web dashboard | **No** — 2026-11 | `cs_status` + `--doctor` already give the numbers where the agent lives. A dashboard would grow a second surface to keep secure. |
| Config hot-reload | **Deferred** | Legit ask; needs careful semantics for live connections. Tracked as a 🟡 issue, not a refusal. |
| Pluggable "gateway middlewares" | **No** — 2026-11 | A plugin API in a zero-dependency single file is how single files stop being single. Compose by *chaining gateways* instead (context-saver can front another context-saver). |

New entries get a dated row when a maintainer makes the call, so rejections
are precedent, not vibes.
