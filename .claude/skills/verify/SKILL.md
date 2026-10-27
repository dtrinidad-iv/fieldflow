---
name: verify
description: Run every check before saying a task is done - secret scan, ESLint, Vitest with coverage, npm audit, and sam validate when the SAM CLI is installed. Use before reporting any change as finished, and before committing.
allowed-tools: Bash(.claude/skills/verify/verify.sh), Bash(.claude/skills/verify/verify.sh *)
---

# Verify

Run from the repo root:

```bash
.claude/skills/verify/verify.sh
```

The steps run in this order:
1. Secret scan (`scripts/scan-secrets.sh`)
2. ESLint
3. Vitest with coverage thresholds
4. `npm audit`, dev dependencies included (high and critical issues fail it)
5. `sam validate --lint`, skipped with a note if the SAM CLI isn't installed (a failure instead with `VERIFY_REQUIRE_SAM=1`)

It ends with `ALL PASSED` or `FAILED: <steps>` and exits non-zero on failure. CI (`.github/workflows/ci.yml`) runs the same steps; when you change one here, change it there too.

## Reporting
- Report the real result: test count, coverage, any failures with their output, and which steps were skipped.
- Never say "done" after a failed step. Fix it and run again, or tell the user exactly what fails.
- A skipped `sam validate` is not a pass. Say it was skipped.
