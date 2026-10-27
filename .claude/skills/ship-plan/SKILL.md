---
name: ship-plan
description: Commit an approved, finished plan - verify, commit by area, mark the plan Done with commit hashes, and push if a remote exists. Use only when the user approves the result ("all good, commit").
disable-model-invocation: true
argument-hint: "[plan number, e.g. 03]"
---

# Ship a plan

Plan: $ARGUMENTS. If no number is given, use the plan marked WIP in `docs/plans/README.md`.

## Steps
1. **Check scope.** Run `git status --short` and `git diff --stat`. Every changed file should belong to this plan. If something unrelated is there, stop and ask; never sweep it into a commit.
2. **Verify.** Run `.claude/skills/verify/verify.sh`. If anything fails, stop and report. Never commit red.
3. **Docs check.** Update a doc in the same commit as the change it describes:
   - New config key → `.env.example`, with a comment.
   - New convention, command or rule → `CLAUDE.md`.
   - New or changed native platform steps → `docs/tadabase-setup.md`.
   - Setup steps or a visible feature → `README.md`, including the "native vs custom" table.
   - Follow-ups found but not done → the plan's "Follow-ups" section.
4. **Commit by area,** in the format `type(scope): summary`, ending with the attribution line from the system reminder:
   - `functions/` and `lib/` → `feat(functions): ...`
   - `widgets/` and `demo/` → `feat(widgets): ...`
   - `template.yaml` and `samconfig.toml` → `chore(infra): ...`
   - `.claude/` → `chore(claude): ...`
   - Tests go with the code they test.
   - The pre-commit hook runs the secret scan, lint and tests. If it fails, fix the cause; never bypass it.
5. **Mark the plan Done.**
   - Under the plan's title, set `**Status:** Done` and `**Commits:** \`<hash>\` (area), ...`.
   - Replace an existing Commits line; don't add a second one.
   - Update the plan's row in `docs/plans/README.md`.
   - Commit with `docs: mark <plan> plan done`.
6. **Push** only if a remote exists: `GIT_TERMINAL_PROMPT=0 git push`. If it fails on auth, report it; don't change remotes or credentials.
7. **Report** the commit hashes and messages, and confirm `git status` is clean.

## Never
- Commit `.env*` (except `.env.example`) or `.claude/settings.local.json`.
- Use `--no-verify`, force-push, or amend pushed commits.
