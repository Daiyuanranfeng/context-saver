# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-08

### Added

- **Single-file MCP gateway** (`context-saver.mjs`, zero runtime dependencies, Node ≥ 18.17).
- Lazy tool-schema loading: 6 fixed meta-tools (`cs_discover`, `cs_plan`, `cs_load`,
  `cs_unload`, `cs_status`, `cs_call`) replace N upstream server schemas in your context window.
- Spec-compliant MCP server: initialize negotiation (`2024-10-07` … `2025-11-25`),
  `tools/list` pagination, `tools/call`, `notifications/tools/list_changed`, `ping`.
- Transports: stdio, Streamable HTTP (`POST/GET/DELETE /mcp` with SSE responses,
  `Mcp-Session-Id`, 15 s keepalives), and legacy HTTP+SSE (`/sse` + `endpoint` event).
- Embedded OAuth 2.1 authorization server: dynamic client registration, PKCE S256,
  approval pop-up, bearer-token protected `/mcp`, refresh tokens, protected-resource
  metadata discovery.
- Downstream multiplexer: stdio and HTTP (Streamable + legacy SSE) downstream servers,
  connect-on-demand, per-request id correlation, timeouts, crash auto-restart,
  idle reaping, disk-cached tool catalog (zero-cost restarts).
- Prompt planner (`cs_plan`): heuristic scoring maps a task to the minimal toolset.
- Token accounting: per-session baseline vs. loaded cost with live savings report.
- Built-in demo fleet (3 servers / 13 tools), interactive REPL client (`--client`),
  self-diagnostic mode (`--doctor`).
- CI: 3-OS × 4-Node test matrix, ESLint, package-gate (asserts the npm tarball is
  exactly one file), multi-platform release artifacts with SHA256SUMS.
- Community pipeline: good-first-issue board, issue forms, triage automation, scope bar.

[1.0.0]: https://github.com/context-saver/context-saver/releases/tag/v1.0.0
