---
name: Bug report
about: Something misbehaved
labels: [needs-triage]
---

**What happened** — the observed behavior, including any error text:

```text

```

**What you expected:**

**How to reproduce:**

1. Config (redact secrets — `${ENV_VAR}` references are fine):

```json

```

2. Client (Claude Code / Cursor / other) and how the gateway was launched:
3. The exact tool call or command sequence:

**Doctor output** (`node context-saver.mjs --doctor` — paste the summary):
```text

```

**Environment:**

- Context-Saver version: `node context-saver.mjs --version`
- Node version: `node -v`
- OS:

**Logs** — run the gateway with `CONTEXT_SAVER_LOG=debug` and attach stderr:
```text

```

<!-- Keep secrets out. Tokens, headers, absolute paths to private repos — redact them. -->
