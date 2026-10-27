---
name: review-diff
description: Review the current change with the project's reviewer subagents in parallel - code-reviewer always, security-auditor for handlers/widgets/dependencies, infra-reviewer for template.yaml or deploy config - then fix confirmed findings. Use after implementing a plan and before ship-plan.
---

# Review the diff

1. Run `git status --short` and `git diff HEAD --stat` to see what changed.
2. Pick reviewers:
   - **code-reviewer:** always.
   - **security-auditor:** if `functions/`, `lib/`, `widgets/`, `package.json` or the lockfile changed.
   - **infra-reviewer:** if `template.yaml`, `samconfig.toml` or `.github/workflows/` changed.
   - **test-writer:** only if a reviewer reports missing tests.
3. Launch the chosen reviewers in parallel, in one message. Give each the plan number, if there is one.
4. For each finding, check it against the code yourself. Fix the real ones. For any you reject, write one line on why.
5. Run the `verify` skill again after fixing.
6. Report a table of findings: reviewer, severity, `file:line`, and fixed / rejected (why).
