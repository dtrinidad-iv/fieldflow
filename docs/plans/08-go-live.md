# 08 — Go live: accounts, first deploy, live checks, walkthrough

**Status:** Deferred (2026-10-28: the user wants a free local demo first; plan 09). Resume from phase A.

## Goal
Take FieldFlow from "built and tested offline" to running for real: an AWS account, the dev
Tadabase app, the first deploy, every live check from plans 03–07, and a walkthrough that
demonstrates the whole flow. Prod follows the same path once dev is proven.

Starting point (the user, 2026-10-28):
- **No AWS account.**
- **A Tadabase account, but no FieldFlow app yet.**
- On this machine: no AWS CLI and no SAM CLI, and Node 22 is active (the project needs 24:
  `nvm use`).

Out of scope:
- New features. A live check that fails gets its own small fix plan; it isn't patched inside this
  one.
- A custom domain for invoice links (a plan 04 follow-up).
- CRM sync (a plan 07 follow-up).

## Decisions
- **One runbook, `docs/go-live.md`,** walks through phases A–H in order. Each step says who does
  it (you or Claude), what to run or click, the expected result, and what to paste back. The setup
  guide stays the reference for *how* to build each part; the runbook is the *order* and the
  checklist.
- **AWS account setup** (phase A, you): new account, then:
  - **MFA on the root user, and no root access keys.** Root is used only for the steps that
    need it.
  - **A budget alarm** (AWS Budgets, $5/month, emailed). Expected cost is near $0: on-demand
    Lambda, API Gateway, DynamoDB and S3 at this traffic, standard SSM parameters (free), and logs
    kept 30 days.
  - **CLI access through IAM Identity Center (SSO)**, not long-lived access keys. That gives
    short-lived credentials, with nothing permanent in `~/.aws`. One user with an
    `AdministratorAccess` permission set, profile `fieldflow`. That's the obvious choice for a
    one-person account, and the project's guard rails already keep Claude to read-only `aws`
    commands.
  - Region `us-east-1`, as in `samconfig.toml`.
- **Tools** (you): `brew install awscli`, then the SAM CLI with AWS's macOS installer or
  `brew install aws/tap/aws-sam-cli`. No Docker needed, since esbuild builds without a container.
  Then `nvm install 24 && nvm use`, and check with `aws --version`, `sam --version` and
  `node --version`.
- **Build the Tadabase app** (phase B, you), following the setup guide. Build the structure as
  `FieldFlow` (sections 2–3), then duplicate it as `FieldFlow Dev`, as section 1 says. Everything
  after that happens in **dev** first. Confirm the plan includes outgoing webhooks (Pro or higher)
  before building.
- **A read-only smoke test after each deploy, `scripts/smoke-test.js <ApiUrl>`.** It calls only
  this stack's endpoints, never Tadabase, and changes nothing:
  - `GET /health` → 200 `{ ok: true, stage }`
  - `GET /invoices/not-a-file` → 400, and `GET /invoices/job1.pdf?sig=<43 x A>` → 403
  - `POST /webhooks/job-completed` and `POST /webhooks/job-schedule` without the secret → 401
  - It prints a pass/fail table and exits non-zero on any failure. The webhook POSTs carry no
    secret, so they're rejected before any work.
- **Live answers get recorded where the code relies on them:**
  - Response shapes, 404 behavior and filter behavior go in CLAUDE.md's "Tadabase API notes".
  - Each plan's pending live checks are marked passed (or failed, with a fix plan) in that plan.
- **Plan 08 is Done** when dev is live, every live check is recorded, and the walkthrough passes
  on dev. Prod (phase H) is either done too or explicitly deferred as a follow-up. Deploying to
  prod needs you to say "prod" (the `safe-deploy` rule).

## Phases (the runbook's outline)
- **A. AWS account and CLI** (you, about 30 min).
  1. Create the account.
  2. Root MFA.
  3. Budget alarm.
  4. IAM Identity Center user and permission set.
  5. `aws configure sso` (profile `fieldflow`), then `aws sts get-caller-identity --profile fieldflow`.
- **B. Tools and Node** (you, about 10 min): install, then check versions.
  - Claude: `VERIFY_REQUIRE_SAM=1 .claude/skills/verify/verify.sh` (now including `sam validate`)
    and `npm run build`.
- **C. Tadabase app** (you, about 1–2 h): setup guide sections 1–3, with every field, including
  plan 07's Slot, Invoice Problem and Schedule Conflict. Then:
  - Create the API keys (section 4, the Tadabase part), and put the dev **read-only** key in `.env`.
  - Run `node --env-file=.env scripts/tadabase-check.js dev`, and paste the output back.
  - Claude fills in `config/tadabase.dev.json` from it, and you run the script again: every line
    `OK`.
  - Claude records the confirmed response keys and 404 behavior in CLAUDE.md. This closes plan 03's
    live check.
  - Fill in `config/invoice.json` (your business details). Claude commits both config files.
- **D. Secrets** (you): the SSM script in setup guide section 4, for `dev`, with
  `AWS_PROFILE=fieldflow`. Then Claude lists the parameter *names* only
  (`aws ssm describe-parameters`, read-only) to confirm all five exist.
- **E. First deploy to dev** (both, through `safe-deploy`):
  1. Claude: clean tree, verify, account check, build, and the changeset.
  2. `infra-reviewer` checks the changeset. It's the first deploy, so everything is an `Add`, and
     the `aws-sam-cli-managed-default` stack gets created.
  3. You execute the changeset.
  4. Claude runs the smoke test and reports the stack outputs.
- **F. Wire up the app** (you): setup guide sections 7–10.
  1. Business details and record rule (section 7).
  2. Paste in the widgets (section 8).
  3. The Kanban board (section 9).
  4. Validation rules (section 10).
  5. Then the outgoing webhooks, after the stack is `UPDATE_COMPLETE`/`CREATE_COMPLETE`. Before
     the invoice webhook, apply section 10 step 4: no Completed jobs without an invoice.
- **G. Live checks and walkthrough** (you click, Claude records). Every pending check, in one
  ordered list in the runbook:
  - **Plan 03:** response shapes and 404 (phase C).
  - **Plan 04:**
    - the job-items filter on the job connection returns that job's items
    - the Invoices record rule fires for records created through the API
    - whether Tadabase retries a webhook after a 5xx or 409, and how often (if not, add a
      CloudWatch alarm on 5xx and 409, as a follow-up plan)
    - what a connection field and a Link field expect on write
    - a missing PDF gives 404, not 403
  - **Plan 05:** widget gates 1–4 (`TB.render`, `name="field_NN"`, a 100 KB Long Text value
    survives, an unsigned required Save shows a message, item inputs are text).
  - **Plan 06:** board checks 1–4.
  - **Plan 07:** checks 5.1–5.5 (connection `is` filter, `contains`, long text read back, Drop
    Down written through the API).
  - **The walkthrough** (`docs/walkthrough.md`), end to end on dev.
- **H. Prod** (when you say "prod"): phases C (prod mapping and its own keys), D, E, F and a short
  G. Prod's first deploy is its own changeset and review.

## Lambda functions (`functions/`, `lib/`)
None planned. A failed live check may need a small change, through its own fix plan.

## Infrastructure (`template.yaml`)
None. The deploy uses the template as it is. The first changeset should show only `Add`
actions; `infra-reviewer` confirms that before you execute it.

## Widgets (`widgets/`)
None.

## Platform setup (`docs/tadabase-setup.md`)
No new steps, but the guide gets two small corrections:
- **Section 4:** add `AWS_PROFILE=fieldflow`, and point readers to `docs/go-live.md` phase A
  for setting up the CLI.
- **Section 1:** a line pointing to the runbook for the order of steps.

## Files
- `docs/go-live.md`: the runbook, with checkboxes, phases A–H, and every live check with its
  expected result.
- `docs/walkthrough.md`: a 15-minute demo script on dev.
  1. Create a customer and two technicians.
  2. Schedule a job with a slot; try to double-book it on the form (blocked), then by dragging
     (flagged).
  3. Move a card on the board.
  4. Add line items (see the live total and a bad-price hint).
  5. Try to complete without signing (blocked), then sign and complete.
  6. The invoice appears, and the job moves to Invoiced; open the PDF link.
  7. Complete a job with no items: it's sent back with the reason.
- `scripts/smoke-test.js`: the read-only endpoint check described above.
- `tests/scripts/smoke-test.test.js`, with fetch faked (tests never touch the network):
  - all pass → exit 0
  - each wrong status → reported, exit 1
  - a network error → reported, exit 1
  - the API URL must be `https://<id>.execute-api.<region>.amazonaws.com`, so the script can't
    be pointed at Tadabase or anywhere else
  - no request ever carries `X-FieldFlow-Secret`
- `README.md`: the Deploying section points to the runbook, and the status line is updated as
  phases complete.
- `CLAUDE.md`: the confirmed Tadabase answers (phases C and G).

## Tests
`tests/scripts/smoke-test.test.js` as above. Everything else in this plan is documentation and
live checks.

## Verification
1. `verify` skill, then `review-diff` (code-reviewer and security-auditor for the smoke-test
   script).
2. The runbook itself: phases A–G done on dev, with every check recorded as passed or linked to a
   fix plan.

## Review (review-diff, 2026-10-28)
code-reviewer and security-auditor. The fixes changed some of the decisions above, and these
replace them:

- **The guard hook had a hole** (security, high; it predates this plan). It accepted every
  `aws ... get-*` as a read, but `aws s3api get-object ... <path>` writes a local file anywhere,
  guard rails included. It also allowed `--no-sign-request` and `--endpoint-url`. With the user's
  OK, the hook (`.claude/hooks/guard-bash.py`) now:
  - blocks `get-` commands that write a file: `s3api get-object` and `get-object-torrent`,
    `apigateway get-export` and `get-sdk`, `glacier get-job-output`, and others
  - blocks `--endpoint-url` and `--no-sign-request` anywhere in the command
  - blocks more credential-printing commands: `ecr get-authorization-token`, `eks get-token`,
    `ec2 get-password-data`, `lightsail get-instance-access-details`, and `--include-value(s)`

  15 hook tests were added.
- **Claude gets its own AWS identity** (security, medium; the user chose this).
  - The plan gave Claude's shell the user's AdministratorAccess profile, with the hook as the only
    thing keeping it read-only.
  - Now there are two permission sets. `fieldflow` (AdministratorAccess) is for the user.
    `fieldflow-claude` is ViewOnlyAccess plus preparing changesets, uploading build artifacts and
    reading `/fieldflow/*` logs, with explicit denies: SSM and KMS reads, invoice PDFs, idempotency
    items, `lambda:GetFunction`/`InvokeFunction`, and executing or creating stacks.
  - `AWS_PROFILE=fieldflow-claude` goes in `~/.zshrc`. The user's own commands pass
    `--profile fieldflow`.
  - The very first `sam deploy --no-execute-changeset`, which creates SAM's artifacts stack, is
    run by the user.
  - The `safe-deploy` skill and CLAUDE.md say so.
- **Secrets never appear inside Claude Code** (security, low): the runbook and the setup guide
  say to use a separate terminal (not `!`). The webhook secret is copied straight to the clipboard
  (`| pbcopy`). The SSM script passes values on stdin (`--value file:///dev/stdin`), not on the
  command line, so they don't show in the process list.
- **`safe-deploy` runs the smoke test** (code, medium): step 9 used to only `curl` health. It now
  reads `ApiUrl` with `describe-stacks` (never from pasted text) and runs
  `scripts/smoke-test.js`.
- **The smoke test:**
  - the stage is required and must be `dev` or `prod` (without it, a prod URL would pass as dev)
  - a body mismatch says why
  - `main(argv)` is exported and tested for its exit codes, plus a body that fails to read
- **The runbook, corrected:**
  - Double-booking can't be made by dragging, since the board only changes Status: use inline
    editing or an import (row 11, setup guide 10.5.2, the README table, a handler comment).
  - Row 19 no longer claims an infra test pins `s3:ListBucket` (none does yet).
  - Phase H commits the prod mapping, and uses `prod` as the script argument.
  - Troubleshooting separates the smoke test's 500 causes (mapping, SSM, link secret) from a
    placeholder `invoice.json`.
  - Row 14 names the connection and Link write check.
  - The F.6 secret command uses the full parameter name.
  - Status defaults to Scheduled (C.2), and the office table has inline editing on Slot (F.4).
- **Not changed:** the smoke test can't prove that a URL belongs to *this* stack, only that it's an
  execute-api URL. Taking `ApiUrl` from `describe-stacks` covers that.

## Follow-ups
- An infra test pinning `s3:ListBucket` on `InvoicePdfRole` (so missing PDFs stay 404).
- Whether `FieldFlowClaude` needs more actions: recorded at the first changeset, then added to
  A.6.

## Commits after approval
- `feat(functions): add a read-only smoke test for a deployed stack`: `scripts/smoke-test.js` and
  its test. (Scripts go under `functions` scope, as plan 03 did.)
- `docs: go-live runbook and walkthrough`: `docs/go-live.md`, `docs/walkthrough.md`, setup guide
  and README pointers.
- Later, as phases complete: `chore(functions): dev mapping and business details` (config),
  `docs: record confirmed Tadabase API behavior` (CLAUDE.md, plan follow-ups).
- `docs: mark 08 plan done`, once phase G passes on dev.
