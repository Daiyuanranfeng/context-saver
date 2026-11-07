# AGENTS.md — rules for AI contributors

You (an AI coding agent) are welcome here. These rules keep your
contributions shippable.

1. **Read the code map first.** `CONTRIBUTING.md` → "The code map". The
   section markers `[01]`–`[16]` in `context-saver.mjs` are your index.
2. **Zero runtime dependencies.** Node built-ins only. No, not even that
   tiny helpful one. Yes, even if it saves fifty lines.
3. **Match the SDK, not your memory of the spec.** For protocol questions,
   read `modelcontextprotocol/typescript-sdk` source and cite file/line in
   the PR. Protocol trivia you're confident about is exactly where bugs
   hide.
4. **Tests are the deliverable.** A fix without its failing-test-first
   reproduction (see `test/audit.test.mjs`) will be closed, not merged.
5. **Never break the single-file claim.** `package-gate` in CI enforces it.
6. **stdout is protocol.** All logs to stderr. No emoji in log lines.
7. **Secrets stay out of logs and errors** — including `Authorization`
   header values you were just debugging.
8. **Don't restate the whole file in PRs.** Diff-level explanations only.
9. **Say what you didn't test.** Windows, macOS, real OAuth providers,
   exotic downstream servers — an honest gap list beats silent hope.
10. **Scoped issues only.** GOOD_FIRST_ISSUES.md items are pre-approved
    designs; implement, don't redesign.

When summarizing your work in a PR, include: what changed, which tests
cover it, what you couldn't verify, and the token-cost delta of any
`tools/list` payload change.
