# Security Policy

## Supported versions

The latest tagged release (and `main` between releases).

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/renniyy/context-saver/security/advisories/new)
— please do not open public issues for suspected vulnerabilities.
Expect an acknowledgement within 7 days.

## What counts as a vulnerability here

- Anything that lets an **unauthenticated** party reach `/mcp`, the OAuth
  endpoints, or any downstream server when the operator followed the
  documented defaults.
- Bypass of the OAuth flow (PKCE downgrade, redirect-URI confusion,
  token forgery, cross-client code replay).
- Token or credential disclosure via logs, error messages, or the catalog
  cache file.
- Sandbox escape from the demo servers (`--demo-server` must stay confined
  to its temp directory).
- Unauthenticated remote crash / memory exhaustion (the gateway must
  degrade, never die — see `test/audit.test.mjs` for the bar).

## What does not

- Compromise of a *downstream* server you configured (your tooling, your
  trust decision — the gateway routes bytes, it does not audit them).
- Prompt-injection content flowing through tool results (inherent to MCP;
  mitigations belong in the client or the tool).
- Attacks requiring local code execution or config-file write access —
  whoever can write your config *is* you.
- The gateway being exposed by an operator who forced `--no-auth
  --insecure --host 0.0.0.0` past the refusal.

## Hardening already in place

Safe-by-default loopback binds · refusal to expose unauthenticated
non-loopback binds · origin validation · OAuth 2.1 with mandatory PKCE S256
and single-use codes · refresh-token rotation · rate-limited token endpoint
· in-memory-only tokens · atomic cache writes · demo servers sandboxed to
temp dirs · tool names sanitized against injection into the client.
