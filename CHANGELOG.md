# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] — 2026-11-08

### Fixed

Audit round 2 — five reproducible defects, each landed with its own commit and
regression test:

- **Security**: the OAuth approval decision authenticated nobody. Three plain
  HTTP POSTs (register → `action=approve` → token exchange) minted a valid
  access token with no browser and no human — on the advertised
  `--host 0.0.0.0 --auth` VPS deployment, anyone who could reach the port owned
  the gateway. Consent pages now embed a one-time approval token the decision
  must present, and non-loopback authenticated binds additionally require a
  pairing secret (`--approval-token` / `CONTEXT_SAVER_APPROVAL_TOKEN`) that the
  consent page asks the human to type; the gateway refuses to start without it
  (fail closed; `--insecure` overrides).
- Long-running gateways leaked OAuth state: expired authorization codes,
  refresh tokens and pending approvals were checked on use but never deleted,
  so abandoned flows accumulated forever. All four maps are now swept on every
  OAuth route touch (throttled) and at each token issuance.
- Malformed percent-escapes (`POST /token` with `code=%E0%A4%A`, `GET /%zz`)
  threw inside `decodeURIComponent` and surfaced as HTTP 500s. Form bodies are
  parsed by a guarded helper (400) and path decoding failures return 404.
- Windows (and any `$HOME`-less context such as services) silently missed
  `~/.context-saver/config.json`: the lookup fell back to the tmpdir instead
  of the profile directory. It now uses `os.homedir()`.
- The shipped file reported `1.0.0` while every piece of metadata said `1.0.1`
  — the CI version gate compared `package.json`/`server.json`/`CHANGELOG` but
  never the file itself. Versions are aligned at 1.0.2 and the gate (plus a
  unit test) now reads the `VERSION` constant out of `context-saver.mjs`.

### Changed

- The Docker image's default non-loopback bind is fail-closed: set
  `CONTEXT_SAVER_APPROVAL_TOKEN` or the gateway refuses to start.

[1.0.2]: https://github.com/renniyy/context-saver/releases/tag/v1.0.2

## [1.0.1] — 2026-11-08

### Fixed

- Throwaway `--demo` configs are deleted eagerly after parsing instead of in an
  `exit` hook — Windows hard-kills (`TerminateProcess`) never run exit handlers,
  so every `--demo` gateway leaked one `context-saver-demo-*.json` file into the
  OS tmpdir (caught by the windows-latest CI legs: `11 -> 12` files).
- The CI single-file package gate no longer uses GNU-only `wc -l` semantics —
  BSD/macOS `wc` pads its output with spaces, failing the macOS leg on a
  perfectly fine tarball. The exact-string comparison that replaced it already
  rejects zero, multiple, or wrongly named `.mjs` entries.
- Repository URLs in `package.json`, `CONTRIBUTING`, `SECURITY`, README badges
  and `.github` templates now point at `renniyy/context-saver`.

### Changed

- GitHub Actions bumped to current majors — `checkout@v7`, `setup-node@v7`,
  `download-artifact@v8`, `stale@v11`, `github-script@v9` — clearing the
  Node.js 20 deprecation warnings on hosted runners (supersedes Dependabot
  PRs #1–#5).

[1.0.1]: https://github.com/renniyy/context-saver/releases/tag/v1.0.1

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
- Built-in demo fleet (3 servers / 16 tools), interactive REPL client (`--client`),
  self-diagnostic mode (`--doctor`).
- CI: 3-OS × 4-Node test matrix, ESLint, package-gate (asserts the npm tarball is
  exactly one file), multi-platform release artifacts with SHA256SUMS.
- Community pipeline: good-first-issue board, issue forms, triage automation, scope bar.

[1.0.0]: https://github.com/renniyy/context-saver/releases/tag/v1.0.0
