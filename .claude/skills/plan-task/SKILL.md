---
name: plan-task
description: Write a task plan in docs/plans/NN-task-name.md with Status Proposed, add it to the index, and stop for approval. Use before building anything that touches more than 3 files, or whenever the user asks for a plan.
argument-hint: "[task description]"
---

# Plan a task

Task: $ARGUMENTS

## Steps
1. **Read first.** Read CLAUDE.md, `docs/plans/README.md`, and the most recent plans that relate to this task. Look at the real code you'll build on. Don't plan against code you haven't opened.
2. **Ask only about real forks**, where the user's answer changes the plan. For anything with an obvious default, choose it and say so in the plan.
3. **Number and name.** The next `NN` is the highest in `docs/plans/` + 1, zero-padded. Name the file in kebab-case, e.g. `03-generate-invoice.md`.
4. **Write the plan** using the template below. Name the actual files, endpoints, adapter calls and tests.
5. **Add a row** to `docs/plans/README.md`: `| NN | [Title](NN-task-name.md) | Proposed |`.
6. **Stop.** Summarize the plan in a few lines and ask for approval. Build nothing until the user says go. When they approve, set Status to **WIP** in both the plan and the README.

## Template
```markdown
# NN — Title

**Status:** Proposed

## Goal
What this adds and why, in 2-3 sentences. What is explicitly out of scope. For custom code: why the low-code platform can't do this natively.

## Decisions
Choices made, with one line on why. Any new dependency and why it's needed (it needs the user's OK).

## Lambda functions (`functions/`, `lib/`)
Handlers, adapter methods, validation, webhook auth, idempotency.

## Infrastructure (`template.yaml`)
New resources, IAM policies, and the data-safety check (Retain policies, no renamed logical ids). Or "none".

## Widgets (`widgets/`)
Files, DOM hooks, how they're installed in the app. Or "none".

## Platform setup (`docs/tadabase-setup.md`)
Native steps the user clicks through in the app builder. Or "none".

## Tests
Cases per handler and widget (happy path, 400, 401, upstream error, duplicate delivery, DOM edge cases).

## Verification
`verify` skill, then `review-diff`. Manual checks in the demo page or the live app, as numbered steps with the expected results.

## Commits after approval
`feat(functions): ...`, `feat(widgets): ...`, `chore(infra): ...`, then this plan → Done.
```

## Rules
- Never plan a script or test that writes to the live app. Live writes happen only through deployed handlers that the user triggers from the app.
- New config keys go in `.env.example` with a comment. Never edit `.env`.
