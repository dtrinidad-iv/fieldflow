# 01 — Claude Code safety tooling

**Status:** WIP

## Goal
Set up the guard rails before any app code exists. AI-assisted work on this repo must not:
- destroy live data (the Tadabase app, AWS resources)
- leak secrets
- ship untested or insecure code

Out of scope: app code, the SAM template and the adapters (plan 02).

## Decisions
- **Hooks block, not just warn.** PreToolUse hooks exit 2 on dangerous commands, subagents included. `sam deploy` is the one exception: it asks the user, so deploys stay possible but never silent.
- **AWS is read-only for Claude.** Only `describe-`, `get-`, `list-` and similar verbs pass. Executing a changeset is the user's job.
- **Defense in depth for live data:**
  1. A hook blocks `curl` writes to the Tadabase API.
  2. `tests/setup.js` blocks all non-local `fetch` in tests.
  3. Vitest blanks the platform credentials.
  4. The adapter (plan 02) refuses writes without `FIELDFLOW_ALLOW_LIVE_WRITES=1`.
- **The git pre-commit hook** (secret scan, lint, tests) protects the user's own commits too. Claude may not bypass it or change `core.hooksPath`.
- **The hooks have tests** (`tests/hooks/hooks.test.js`), so changing a guard can't silently weaken it.
- **Dev dependencies:**
  - ESLint 9 with `eslint-plugin-security`
  - Vitest 4.1.12, the first Node-20 version without the tinypool/mocker advisories
  - `@vitest/coverage-v8`, for coverage
  - jsdom, for widget tests

## Files
- `.claude/settings.json`: allow, ask and deny permissions, plus hook wiring.
- `.claude/hooks/`:
  - `guard-bash.py`
  - `protect-files.py`
  - `post-edit-check.sh`
  - `only-tests.sh`
- `.claude/agents/`:
  - `code-reviewer`
  - `security-auditor`
  - `infra-reviewer`
  - `test-writer` (edits limited to `tests/`)
- `.claude/skills/`:
  - `verify` (with `verify.sh`)
  - `review-diff`
  - `plan-task`
  - `ship-plan`
  - `new-lambda`
  - `safe-deploy`
- `scripts/scan-secrets.sh` and `.githooks/pre-commit`.
- `package.json`, `eslint.config.js`, `vitest.config.js`, `tests/setup.js`, `.gitignore`, `.env.example`.
- `.github/workflows/ci.yml`: the same steps as `verify.sh`.
- `CLAUDE.md`.

## Tests
- `tests/hooks/hooks.test.js`: every blocked command and file (including each bypass from the review), the allowed everyday commands, the `sam deploy` ask, the guard-rail edit ask, and both test-writer hooks.
- `tests/hooks/scan-secrets.test.js`: planted fake secrets in a throwaway repo, in both modes.
- `tests/setup.test.js`: network block (fetch, http/https, sockets, import time) and credential blanking.

## Verification
- `.claude/skills/verify/verify.sh` → `ALL PASSED`. `sam validate` is skipped because there's no template yet.
- The secret scan finds a planted fake AWS key, and the pre-commit hook rejects it.

## Review (review-diff, 2026-10-28)
code-reviewer, security-auditor and infra-reviewer found that the first version of the guards
stopped only the obvious form of each command. 36 bypasses were probed against the hooks, and all
36 got through: quoted `;` splitting commands wrongly, wrappers and subshells (`bash -c`, `timeout`,
`( )`, `&`), git global options (`git -C . reset --hard`), `git commit -n`, `export
FIELDFLOW_ALLOW_LIVE_WRITES=1`, `sam deploy && aws ... execute-change-set` (the ask skipped the
rest of the command), secret reads with upper-case names, globs, symlinks and Grep, writes to the
hooks themselves, and an AWS secret read through `get-` verbs.

Fixed in this plan:
- `guard-bash.py` rewritten on a quote-aware tokenizer (`guard_common.py`). It unwraps shells,
  `eval`, `$(...)`, backticks, heredocs and wrappers, scans inline interpreter code, parses git /
  aws / sam options properly, and fails closed. `sam deploy` must be `--no-execute-changeset`,
  run on its own. Shell writes to the guard rails are blocked.
- `protect-files.py`: case-insensitive, symlinks resolved, Grep and Glob inputs handled, a wider
  secret list, samconfig checked on the file as it would be after the edit, and an ask before
  editing the guard rails.
- test-writer: symlink-proof path check, no edits to `tests/setup.js` or `tests/hooks/`, and a
  Bash hook that limits it to test runs and reads.
- `tests/setup.js`: blocks all non-local sockets from import time on (fetch, http/https, net);
  Vitest blanks the AWS credentials too.
- `scan-secrets.sh`: scans untracked files and `tests/`, more patterns, unquoted values, masked output.
- CI: actions pinned to commit SHAs, `persist-credentials: false`, `npm audit` includes dev
  dependencies. `verify.sh` gains `VERIFY_REQUIRE_SAM=1` for safe-deploy.
- `.claude/settings.json` (approved by the user): protect-files also runs on Grep and Glob, and deny
  rules back up the hooks (`sam sync`, `sam remote`, `aws cloudformation delete-stack` /
  `execute-change-set`, `aws s3 rm` / `rb`, `git commit -n`, more secret files).
- Tests: every probed bypass, plus everyday commands that must still pass, and the settings wiring
  (`tests/hooks/`).

## Follow-ups
- Plan 02: a template test that every stateful resource keeps both `Retain` policies and its
  logical id; consider a stack policy and termination protection.
- The pre-commit hook lints and tests the working tree, not the staged content.
- Script files run by an interpreter (`python3 x.py`, `bash x.sh`) and `git apply` / `patch` aren't
  inspected by the hook; the permission prompt is the guard there.
- CI actions are on older majors (checkout v4, setup-node v4, setup-sam v2); move to current ones
  and let Dependabot update the pins.

## Commits after approval
`chore(claude): add safety hooks, reviewer agents and skills`, then `docs: mark 01 plan done`.
