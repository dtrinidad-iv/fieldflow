# FieldFlow

A field-service job tracker built natively on a low-code platform (Tadabase), extended where the platform falls short:
- AWS Lambda functions (`functions/`, Node 20, AWS SAM)
- shared code (`lib/`)
- vanilla JS/CSS widgets injected into app pages (`widgets/`)

The guiding rule: **build natively first; write code only when the platform can't do it.** Every custom piece is justified in the README's "native vs custom" table.

## Commands
- `npm test`: Vitest (handlers, adapters, widgets with jsdom, and the safety hooks)
- `npm run lint`: ESLint, with the security plugin and the no-innerHTML rule for widgets
- `.claude/skills/verify/verify.sh`: everything (secret scan, lint, tests with coverage, npm audit, sam validate). Run it before saying a task is done.
- `sam build`: bundles each function with esbuild (`Metadata: BuildMethod: esbuild`, `CodeUri: ./`, one entry point per function). Needs the SAM CLI.

## Conventions
- Handlers export `createHandler({ platform, config })`, so tests inject `lib/platform/memory.js`. Only the exported `handler` wires up the real Tadabase adapter.
- Order inside a handler:
  1. Verify the webhook secret (constant-time)
  2. Validate input
  3. Do the work through the adapter
  4. Return JSON
- Handlers are idempotent: a retried webhook never duplicates a side effect.
- Shared code in `lib/`:
  - `http.js`: `wrap` (every handler), `json`, `parseJsonBody`
  - `errors.js`: throw `badRequest` / `unauthorized`, ...; adapters throw `PlatformError`
  - `webhook.js`: `verifySecret`
  - `validate.js`, `log.js` (redacts secrets), `config.js`
  - `platform/`: the adapter interface (`index.js`), `memory.js`, `tadabase.js`. Adapter behavior is pinned by `tests/lib/platform/contract.test.js`, run against both.
- New stateful resources in `template.yaml` get `DeletionPolicy: RetainExceptOnCreate` (or `Retain`), `UpdateReplacePolicy: Retain`, and an entry in `tests/infra/stateful-resources.json` with their replacement-forcing properties. That file is append-only, and editing it needs the user's approval.
- Widgets: no secrets, no `innerHTML` with data, safe to mount twice, visible loading/empty/error states.
- Commits: `type(scope): summary`, with scopes `functions`, `widgets`, `infra`, `claude`, `docs`.
- Plans: one file per task in `docs/plans/NN-name.md` (Proposed → WIP → Done), indexed in `docs/plans/README.md`. Use the `plan-task` and `ship-plan` skills.

## Safety rules (enforced by hooks; don't work around them)
**Live data**
- Tests and local runs never touch the live app. `tests/setup.js` blocks every non-local connection (fetch, http/https, sockets), and Vitest blanks the Tadabase and AWS credentials.
- The Tadabase adapter refuses writes unless `FIELDFLOW_ALLOW_LIVE_WRITES=1`, which is set only in the deployed stack.
- Claude may not `curl` writes to `api.tadabase.io`.

**AWS**
- Claude runs read-only `aws` commands only, and none that print secrets (`--with-decryption`, `get-secret-value`, ...).
- `sam deploy --no-execute-changeset`, run as a command on its own, asks the user; every other `sam deploy` is blocked. `sam delete`, `sam sync`, `sam remote`, `sam package` and `sam pipeline` are blocked.
- Deploys go through the `safe-deploy` skill: changeset → infra-reviewer → the user executes it.
- Stateful resources keep `DeletionPolicy: Retain` (or `RetainExceptOnCreate`) and `UpdateReplacePolicy: Retain`. Never rename their logical ids or change a property that forces a replacement. `tests/infra/template.test.js` enforces this, and infra-reviewer checks every changeset.

**Secrets**
- `.env*` (except `.env.example`), `.envrc`, `env.json`, keys and credential stores (`~/.aws`, `~/.ssh`, ...) are never read, searched or written.
- Secrets live in SSM Parameter Store in AWS.
- The pre-commit hook (`.githooks/`, installed by `npm install`) runs the secret scan, lint and tests.

**Git**
- No force push, `reset --hard`, `clean -f`, discarding changes, deleting branches, or `--no-verify`.
- If a safety hook blocks something you really need, stop and ask the user to run it.

## Claude Code tooling (`.claude/`)
**Hooks**
- `guard-bash.py`: blocks destructive, secret-leaking or outward-facing commands, and shell writes to the guard rails. Runs on every Bash call, subagents included. It parses quotes and unwraps `bash -c`, `eval`, `$(...)`, wrappers (`timeout`, `xargs`, `env`, ...), and fails closed on anything it can't parse. Scripts run from a file aren't inspected; the permission prompt covers those.
- `protect-files.py`: blocks reading, searching or writing secrets, editing `.git/` or the lockfile, and turning off changeset confirmation. Asks the user before any edit to the guard rails: `.claude/hooks`, `.claude/agents`, `.claude/settings*.json`, `.githooks`, the verify skill, `scripts/scan-secrets.sh`, `tests/setup.js`, `tests/hooks`.
- `post-edit-check.sh`: ESLint plus the related tests after every JS edit; the hook tests after editing a hook or script.
- `only-tests.sh` and `only-tests-bash.py`: keep test-writer's edits inside `tests/` (not the test safety net) and its shell to test runs and reads.
- `guard_common.py`: the shared tokenizer and path rules.
- Their behavior is pinned by `tests/hooks/`. When you change a hook, update the tests.

**Agents**, all read-only except test-writer:
- `code-reviewer`
- `security-auditor`
- `infra-reviewer`: data safety, IAM, changesets
- `test-writer`

**Skills**
- `verify`
- `review-diff`: runs the reviewers in parallel
- `plan-task`
- `ship-plan`: user-invoked
- `new-lambda`
- `safe-deploy`: user-invoked

## Tadabase API notes (checked against docs.tadabase.io)
- Base URL: `https://api.tadabase.io/api/v1`.
- Auth headers on every request: `X-Tadabase-App-id`, `X-Tadabase-App-Key`, `X-Tadabase-App-Secret`.
- Records endpoints:
  - `GET` and `POST` on `/data-tables/{tableId}/records`
  - `GET` and `POST` (update), and `DELETE`, on `/data-tables/{tableId}/records/{recordId}`
- Field slugs (`field_NN`) come from `GET /data-tables/{tableId}/fields`. Map them in config, never hard-code them in handlers.
- Outgoing webhooks (Pro plan and up) send record data on create, update and delete, and can be filtered by field values.
