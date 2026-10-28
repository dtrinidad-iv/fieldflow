# Go live

The order of steps to take FieldFlow from "tested offline" to running, starting with no AWS account
and no Tadabase app. Each step says who does it: **you** (in a browser or your own terminal) or
**Claude** (in this repo). The [setup guide](tadabase-setup.md) explains *how* to build each part;
this page is the order and the checklist.

Do everything in **dev** first. Prod (phase H) repeats the same steps once dev works.

Contents: [A. AWS account](#a-aws-account-you-about-30-min) ·
[B. Tools and CLI sign-in](#b-tools-and-cli-sign-in-you-then-claude-about-15-min) ·
[C. Tadabase app](#c-tadabase-app-you-then-claude-about-12-h) ·
[D. Secrets](#d-secrets-you-then-claude-5-min) ·
[E. First deploy](#e-first-deploy-to-dev-both-about-15-min) ·
[F. Wire up the app](#f-wire-up-the-app-you-about-30-min) ·
[G. Live checks and walkthrough](#g-live-checks-and-walkthrough-you-click-claude-records) ·
[H. Prod](#h-prod-when-you-say-prod) · [Troubleshooting](#troubleshooting)

**Two AWS identities, on purpose.** You get **administrator** access (profile `fieldflow`), for
the few things only you do: storing secrets and running a deploy. Claude gets a **separate,
smaller** identity (profile `fieldflow-claude`). It can look at resources, read FieldFlow's logs
and *prepare* a deploy (a changeset), and AWS itself refuses it anything else: reading secrets,
reading invoice PDFs, running a deploy. Claude Code's guard hooks block those too, but the AWS
permissions don't depend on the hooks being right.

**Never show a secret inside Claude Code**, not even with the `!` prefix: it would land in the
session. Commands that touch secret values (D.1, F.6) go in a **separate terminal window**.

## A. AWS account (you, about 30 min)
- [ ] **1. Create the account.** On aws.amazon.com, choose *Create an AWS account*. You'll need an
  email address, a card and a phone for verification. Pick the free *Basic* support plan.
- [ ] **2. Protect the root user.** Signed in as root: account menu (top right) → *Security
  credentials* → *Assign MFA device* (a passkey or an authenticator app). **Don't create access
  keys for root.** From now on, root is only for billing and account settings.
- [ ] **3. Budget alarm.** *Billing and Cost Management* → *Budgets* → *Create budget* → template
  *Monthly cost budget*, **$5**, your email. FieldFlow should cost close to $0 at this traffic
  (pay-per-request Lambda, API Gateway, DynamoDB and S3; free standard SSM parameters; logs kept 30
  days). The alarm tells you if that's ever wrong.
- [ ] **4. Turn on IAM Identity Center** (short-lived CLI credentials, no permanent keys on your
  laptop):
  1. Switch the console region to **US East (N. Virginia) us-east-1**, the stack's region.
  2. Search *IAM Identity Center* → *Enable*.
  3. *Users* → *Add user* (your email). Accept the invitation email, then set a password and MFA.
  4. Copy the **AWS access portal URL** from the Identity Center dashboard (you need it in B).
- [ ] **5. Your permission set:** *Permission sets* → *Create* → *Predefined* →
  **AdministratorAccess**. Keep the session at 1 hour.
- [ ] **6. Claude's permission set:** *Permission sets* → *Create* → *Custom permission set*:
  - Name **`FieldFlowClaude`**, session duration 8 hours.
  - *AWS managed policies*: **ViewOnlyAccess** (lists and describes resources, but doesn't read
    their contents). Not ReadOnlyAccess, which can read secret values and files.
  - *Inline policy*: paste the policy below.

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "PrepareChangesetsOnly",
        "Effect": "Allow",
        "Action": [
          "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet",
          "cloudformation:ListChangeSets", "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources",
          "cloudformation:GetTemplate", "cloudformation:GetTemplateSummary",
          "cloudformation:ValidateTemplate"
        ],
        "Resource": "*"
      },
      {
        "Sid": "UploadBuildArtifacts",
        "Effect": "Allow",
        "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
        "Resource": [
          "arn:aws:s3:::aws-sam-cli-managed-default-samclisourcebucket-*",
          "arn:aws:s3:::aws-sam-cli-managed-default-samclisourcebucket-*/*"
        ]
      },
      {
        "Sid": "ReadFieldFlowLogs",
        "Effect": "Allow",
        "Action": ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartLiveTail"],
        "Resource": "arn:aws:logs:us-east-1:*:log-group:/fieldflow/*"
      },
      {
        "Sid": "NeverSecretsDataOrDeploys",
        "Effect": "Deny",
        "Action": [
          "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
          "ssm:GetParameterHistory", "kms:Decrypt", "secretsmanager:GetSecretValue",
          "cloudformation:ExecuteChangeSet", "cloudformation:CreateStack",
          "cloudformation:UpdateStack", "cloudformation:DeleteStack",
          "lambda:InvokeFunction", "lambda:GetFunction",
          "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem"
        ],
        "Resource": "*"
      },
      {
        "Sid": "NeverInvoicePdfs",
        "Effect": "Deny",
        "Action": "s3:GetObject",
        "Resource": "arn:aws:s3:::fieldflow-*/*"
      }
    ]
  }
  ```

  If a later changeset fails with `AccessDenied` for an action not listed here, Claude reports the
  exact action, and you decide whether to add it.
- [ ] **7. Assign both:** *AWS accounts* → tick your account → *Assign users or groups* → your
  user → both **AdministratorAccess** and **FieldFlowClaude**.

## B. Tools and CLI sign-in (you, then Claude, about 15 min)
- [ ] **1. Install** (macOS, with Homebrew):
  ```bash
  brew install awscli
  brew install aws/tap/aws-sam-cli      # or AWS's macOS installer for the SAM CLI
  nvm install 24 && nvm use             # the repo's .nvmrc says 24
  aws --version && sam --version && node --version
  ```
  No Docker needed: the functions are built with esbuild.
- [ ] **2. Sign the CLI in, with two profiles:**
  ```bash
  aws configure sso
  #   SSO session name: fieldflow
  #   SSO start URL:    <the AWS access portal URL from A.4.4>
  #   SSO region:       us-east-1
  #   pick your account, then AdministratorAccess
  #   CLI default region: us-east-1, output: json, profile name: fieldflow
  aws configure sso
  #   SSO session name: fieldflow  (the same session, so one login covers both)
  #   pick your account, then FieldFlowClaude
  #   CLI default region: us-east-1, output: json, profile name: fieldflow-claude
  aws sts get-caller-identity --profile fieldflow
  aws sts get-caller-identity --profile fieldflow-claude
  ```
  Add `export AWS_PROFILE=fieldflow-claude` to `~/.zshrc`, so new shells (Claude's included) use the
  smaller identity by default. Your own admin commands say `--profile fieldflow` explicitly. When
  a session expires, run `aws sso login --sso-session fieldflow`.

  (The sign-in cache in `~/.aws` can mint credentials for both identities. Claude Code's hooks block
  any access to `~/.aws`, and that's one more reason never to run unreviewed scripts.)
- [ ] **3. Claude:** `aws sts get-caller-identity` (it should show the `FieldFlowClaude` role), then
  `VERIFY_REQUIRE_SAM=1 .claude/skills/verify/verify.sh` (now with `sam validate`) and
  `npm run build`. Expect: `ALL PASSED`, `Build Succeeded`.

## C. Tadabase app (you, then Claude, about 1–2 h)
- [ ] **1. Plan.** Confirm the Tadabase plan includes **outgoing webhooks** (Pro or higher), as
  in setup guide section 1.
- [ ] **2. Build the app:** setup guide sections 2 and 3. Create every table and field, including
  plan 07's Slot, Invoice Problem and Schedule Conflict on Jobs. Set the Jobs **Status** field's
  default to `Scheduled`. Build it as `FieldFlow`, then duplicate it as `FieldFlow Dev`. Everything
  below happens in **FieldFlow Dev**.
- [ ] **3. API keys:** setup guide section 4, the Tadabase part (two keys in the dev app). Put the
  **read-only** `fieldflow-check` values in `.env`, copied from `.env.example`.
- [ ] **4. Discover:** `node --env-file=.env scripts/tadabase-check.js dev`, and paste the output
  to Claude. It prints table ids, field names, slugs and types only, never records or keys.
- [ ] **5. Claude** fills in `config/tadabase.dev.json` from that output and sets
  `"placeholder": false`.
- [ ] **6. Check:** run the same command again. Every line should say `OK` (`CHECK` lines: fix the
  field type or confirm it). Paste the output to Claude.
- [ ] **7. Claude** records the confirmed response keys and the 404 behavior in CLAUDE.md
  ("Tadabase API notes"). This closes plan 03's live check.
- [ ] **8. Business details:** tell Claude your business name, address lines, billing email,
  currency, locale and time zone. Claude fills in `config/invoice.json`, sets `"placeholder":
  false`, and **commits both config files**. The deploy bundles whatever is committed. (These
  details are on every invoice anyway, but if the repo is public, they'll be public too.)

## D. Secrets (you, then Claude, 5 min)
- [ ] **1. In a separate terminal:** run the SSM script in setup guide section 4 with
  `STAGE=dev`, using the dev app's **read/write** `fieldflow-aws` key. It uses your admin profile,
  and creates five SecureStrings under `/fieldflow/dev/`.
- [ ] **2. Claude** confirms they exist by name only (values are never printed, and Claude's
  identity is denied reading them):
  `aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/fieldflow/dev/ --query 'Parameters[].Name'`.
  Expect five names: `tadabase/app-id`, `tadabase/app-key`, `tadabase/app-secret`,
  `webhook-secret`, `link-secret`.

## E. First deploy to dev (both, about 15 min)
- [ ] **1. You:** type `/safe-deploy dev`. Claude:
  1. checks that the git tree is clean
  2. runs every check, including `sam validate`
  3. shows you the AWS account to confirm
  4. builds
  5. prepares a **changeset**: a preview that changes nothing yet

  On the very first deploy in this account, SAM must also create its artifacts stack
  (`aws-sam-cli-managed-default`), which Claude's identity can't do. Claude then asks you to run
  that one command yourself, with `--profile fieldflow`.
- [ ] **2. Claude** has `infra-reviewer` check the changeset. On the first deploy, every line
  should be **Add**, with no Remove and no Replacement.
- [ ] **3. You** run the deploy, after reading the changeset:
  `aws cloudformation execute-change-set --change-set-name <the ARN Claude shows> --profile fieldflow`,
  then wait:
  `aws cloudformation wait stack-create-complete --stack-name fieldflow-dev --profile fieldflow`.
- [ ] **4. Claude** reads the stack outputs with `describe-stacks` (`ApiUrl`,
  `JobCompletedWebhookUrl`, `JobScheduleWebhookUrl`, `InvoicesBucketName`), never from pasted
  text, and runs the smoke test: `node scripts/smoke-test.js <ApiUrl> dev`. Expect five `OK`
  lines: health, two invoice-link rejections (400, 403), and two webhooks rejecting a request
  without the secret (401).

## F. Wire up the app (you, about 30 min)
In **FieldFlow Dev**, after the stack is `CREATE_COMPLETE`:
- [ ] **1. Invoices:** setup guide section 7, the record rule (the business details were done in C.8).
- [ ] **2. Widgets:** setup guide section 8 (the Complete job form, paste the code, mount
  snippets).
- [ ] **3. Board:** setup guide section 9 (the Kanban, guard rails, permissions).
- [ ] **4. Job checks:** setup guide section 10, steps 1 and 2 (validation rules, showing the flags).
  For the walkthrough, also give the office an **office Jobs table with inline editing on Slot**
  (never on Signature: section 8, step 2).
- [ ] **5. Before the invoice webhook:** section 10, step 4: no Completed jobs without an invoice.
  A fresh dev app has none.
- [ ] **6. Outgoing webhooks** (setup guide section 6 explains the pattern). Each sends header
  `X-FieldFlow-Secret: <webhook-secret>` and body `{"recordId": "{record_id}"}`:
  - Jobs, on **update**, filtered to Status = `Completed` → `JobCompletedWebhookUrl`
  - Jobs, on **create**, **update** and **delete** → `JobScheduleWebhookUrl`

  To get the webhook secret, **in a separate terminal** (not in Claude Code), copy it straight to
  the clipboard so it's never on screen, then paste it into the webhook header:
  `aws ssm get-parameter --with-decryption --name /fieldflow/dev/webhook-secret --query Parameter.Value --output text --profile fieldflow | pbcopy`.

## G. Live checks and walkthrough (you click, Claude records)
Work down the list in the dev app. Tell Claude each result. Claude records it in the plan it
belongs to (and in CLAUDE.md for API behavior). A failed check gets its own small fix plan; it
isn't patched here.

| # | From | Check | Expected |
|---|---|---|---|
| 1 | 03 | Response shapes and 404 behavior | Recorded in C.7 |
| 2 | 05 | The signature pad and line total appear | No "field was not found" message; if there is one, inspect the input and send its attributes |
| 3 | 05 | Sign a job and save it | The details page shows the signature as an image (a 100 KB Long Text value comes back intact) |
| 4 | 05 | Save the Complete job form unsigned | A visible "required" message, not a dead Save button |
| 5 | 05 | Type `1.234,50` as a unit price | The line total shows a hint. If not, the inputs are `type="number"` (send what Inspect shows) |
| 6 | 06 | Drag Scheduled → In Progress, then reload | The card stays moved |
| 7 | 06 | Drag into Completed or Invoiced, or out of them | Not possible (or those columns aren't on the board) |
| 8 | 06 | A role without permission | Can't drag |
| 9 | 06 | Any form or table | Can't set Status to Invoiced by hand |
| 10 | 07 | Double-book on the form | Blocked with the message (Date and Slot accepted as additional fields) |
| 11 | 07 | Double-book by **inline editing** the Slot (or by an import; dragging on the board only changes Status, so it can't double-book) | Both jobs show Schedule Conflict within seconds; changing one back clears both |
| 12 | 07 | Clear a conflict by deleting one job, then by changing its technician | The other job's flag clears |
| 13 | 07 | Three or more jobs in one slot (an import is easiest) | At most 5 ids listed, and the flags stop changing within seconds |
| 14 | 04, 07 | Complete a signed job that has line items | An Invoices record appears with Amount and PDF link, **connected to the job**, and the job moves to **Invoiced**. This confirms what a connection and a Link field accept on write, and that the record rule fires for API-created records |
| 15 | 04 | Open the PDF link | The invoice PDF. With the last character of `sig` changed: 403 |
| 16 | 04 | A job's items | The invoice lists exactly that job's items (the job-connection filter works) |
| 17 | 07 | Complete a job with no line items | Back to In Progress; Invoice Problem says why (a Drop Down write through the API works) |
| 18 | 04 | Webhook retries | In Tadabase's webhook settings or delivery log: are failed deliveries (5xx, 409) retried, and how often? Claude also looks for repeated deliveries of one job in the function's logs. If they're never retried, a fix plan adds an alarm on 5xx/409 |
| 19 | 04 | A PDF that doesn't exist | 404, not 403. Testing this needs a validly signed link to a job with no PDF, which only exists if a PDF was removed. Unless such a case comes up, Claude records it as checked in configuration only: `InvoicePdfRole` has `s3:ListBucket` in `template.yaml` (no test pins it yet) |
| 20 | — | **The walkthrough** ([walkthrough.md](walkthrough.md)) | Every step as described |

When rows 1–20 are recorded, plan 08 can be marked Done (prod may follow later).

## H. Prod (when you say "prod")
The same path for the `FieldFlow` app and the `fieldflow-prod` stack:
- **C.3–C.7**, with `prod` as the script argument (`scripts/tadabase-check.js prod`) and prod's own
  API keys in `.env`. Claude fills in `config/tadabase.prod.json`, and **commits it** before the
  deploy.
- **D:** `STAGE=prod`, with prod's keys and new random webhook and link secrets.
- **E:** `/safe-deploy prod`. Deploying to prod needs you to say "prod", and it gets its own
  changeset and review. The smoke test runs with `prod`.
- **F**, then a short **G**: rows 2, 6, 11 and 14, plus the walkthrough with a test customer, then
  delete the test records.

## Troubleshooting
- **Smoke test: a webhook answers 500 instead of 401.** The function failed before it could check
  the secret: either `config/tadabase.<stage>.json` still has `"placeholder": true` (C.5) or wasn't
  committed before the deploy, or an SSM parameter is missing (D.2). Claude can tell which from the
  function's logs.
- **Smoke test: the invoice wrong-signature check answers 500 instead of 403.** The `link-secret`
  parameter is missing (D.1).
- **The smoke test passes, but completing a job gives no invoice, and the logs say "placeholder
  business details".** `config/invoice.json` wasn't filled in and committed (C.8). It's only read
  after a valid webhook, so the smoke test can't see it.
- **401 from a webhook Tadabase sends:** the `X-FieldFlow-Secret` header doesn't match the SSM
  value for this stage.
- **What did a function do?** Claude can read its logs, for example
  `aws logs tail /fieldflow/dev/generate-invoice --since 30m`. The logs hold ids and counts, never
  secrets or record contents.
- **`AccessDenied` for Claude:** Claude's identity lacks an action (A.6). Claude names it; you
  decide whether to add it.
- **`ExpiredToken` / "The SSO session has expired":** `aws sso login --sso-session fieldflow`.
