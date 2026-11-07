<!-- Thank you! One behavior per PR. CONTRIBUTING.md has the ground rules. -->

## What

<!-- The behavior change, in one or two sentences. -->

## Why

<!-- The problem it fixes or the spec bullet it implements. Cite SDK file/line for protocol work. -->

## How to verify

```bash
npm test
npm run lint
node context-saver.mjs --doctor
```

- [ ] `npm test` green locally (all suites)
- [ ] `npm run lint` — 0 problems
- [ ] `node context-saver.mjs --doctor` exits 0
- [ ] Failing-test-first reproduction included (for bug fixes)
- [ ] CHANGELOG.md entry added
- [ ] No new runtime dependency, no new implementation file (single-file claim intact)
- [ ] Token-cost delta of anything the model sees: **none / +N tok (justified)**

## Not tested / caveats

<!-- Honestly: Windows, macOS, exotic downstream servers, OAuth providers... "nothing" is also an answer worth double-checking. -->
