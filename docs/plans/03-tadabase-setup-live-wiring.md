# 03 — Tadabase setup guide and live adapter wiring

**Status:** Done (live check pending, see Follow-ups)
**Commits:** `e767856` (functions), `cb21b13` (infra), `ff1f184` (claude), `83cab8b` (docs)

## Goal
Make the platform adapter usable for real, without any write to the live app in this plan:
- a step-by-step guide to the Tadabase app (tables, fields, API key, webhooks)
- secrets loaded from SSM
- table ids and field slugs mapped in config, never in handlers
- one `getRuntime()` that every deployed handler (plans 04–07) uses to get its config, secrets and Tadabase adapter
- a read-only check the user runs against the live app, which confirms the mapping and the API response shapes that plan 02 took from the docs

Out of scope:
- the handlers themselves (04–07)
- the first deploy and the SSM parameter values in AWS (08)
- any write to the live app

Why custom: the platform holds the data and sends the webhooks natively. Reading secrets at runtime and mapping field slugs is plumbing that only the Lambda side needs.

## Decisions
- **Dev vs prod: the user chose A.** Both stages set `AllowLiveWrites=true`, against separate apps.
  - **A (recommended):** a separate Tadabase app for dev, a copy of the prod app. Each stage gets its own credentials and its own mapping file, and dev can be tested end to end without touching real data. This needs a plan that allows a second app.
  - **B:** one app, and the dev stack is read-only. `AllowLiveWrites=false` for dev, so a dev webhook that tries to write gets a 500 instead of changing prod data. Cheaper, but writes can only be tested in prod.

  Either way, live writes become a template parameter (`AllowLiveWrites`, set per stage in `samconfig.toml`) instead of a hard-coded `'1'`. Prod stays `true`.
- **Secrets in SSM SecureString:**
  - Four parameters per stage:
    - `/fieldflow/<stage>/tadabase/app-id`
    - `/fieldflow/<stage>/tadabase/app-key`
    - `/fieldflow/<stage>/tadabase/app-secret`
    - `/fieldflow/<stage>/webhook-secret`
  - CloudFormation can't create SecureStrings, so you create them once with the commands in the setup guide. Claude can't run those, because AWS writes are blocked.
  - They're read with one `GetParameters` call (`WithDecryption`) and cached for 5 minutes per warm Lambda, so a rotated secret takes effect within 5 minutes.
- **SSM client: the AWS SDK v3 that ships in the Node 24 Lambda runtime.**
  - No new dependency: `@aws-sdk/client-ssm` is marked `External` in the esbuild metadata, and loaded with a dynamic `import()` only by the real secret loader.
  - Tests inject a fake client.
- **Mapping lives in `config/tadabase.<stage>.json`:** table ids and field slugs (`field_NN`) under logical names, for example `jobs.status`.
  - Committed, since they aren't secrets.
  - Bundled into each function by esbuild.
  - Checked at load time: every logical field the code uses must be mapped.
- **Webhook auth:** Tadabase outgoing webhooks support custom headers, so the app sends `X-FieldFlow-Secret`, checked by `lib/webhook.js`. Payloads are custom JSON templates with `{record_id}` and `{field_slug}` placeholders.
- **No new dependencies.**

## Lambda functions (`functions/`, `lib/`)
- **`lib/secrets.js`: `createSecretLoader({ stage, client, ttlMs = 300000, now })`**
  - `load()` returns `{ tadabase: { appId, appKey, appSecret }, webhookSecret }`.
  - It makes one `GetParameters` call for the four names, with `WithDecryption: true`.
  - A missing or invalid parameter throws an error that names the parameter, never its value.
  - The result is cached until the TTL runs out. A failed load isn't cached.
  - `ssmClient()` builds the real client: `await import('@aws-sdk/client-ssm')`.
- **`lib/schema.js`: `loadSchema(stage)` and `validateSchema(schema, required)`**
  - `loadSchema` imports `config/tadabase.<stage>.json`.
  - `validateSchema`:
    - checks table ids against `[A-Za-z0-9_-]{1,64}`, and slugs against `^field_\d+$`
    - requires every logical field in `REQUIRED_FIELDS`
    - rejects duplicate slugs within a table
  - `REQUIRED_FIELDS` is the field list from the setup guide below. Later plans only read from it.
  - Helpers:
    - `fieldsOf(schema, 'jobs')` maps logical name to slug
    - `toLogical(schema, 'jobs', record)` turns a raw record into a `{ title, status, ... }` object
    - `toSlugs(schema, 'jobs', values)` does the reverse, for writes
- **`lib/runtime.js`: `getRuntime({ env = process.env, secretLoader, fetch })`**
  - Builds `{ config, schema, platform, secrets, log }` for the exported `handler`s.
  - The platform is created with `allowLiveWrites: config.allowLiveWrites`, the `readConfig` result: exactly `"1"`, and never under `sam local`.
  - It caches config and schema per container, and reloads secrets after the TTL. It's injectable for tests.
- **`lib/platform/tadabase.js` and `memory.js`: a new read-only `listFields(tableId)`**
  - Calls `GET /data-tables/{tableId}/fields` and returns `[{ slug, name, type }]`.
  - The memory adapter returns fields from its `fields` option.
  - Covered by the contract suite.
- **`scripts/tadabase-check.js`** (run by the user: `node --env-file=.env scripts/tadabase-check.js dev`)
  - **Read only.** It builds the adapter with `allowLiveWrites: false`, and the test asserts every request is a GET.
  - For each mapped table, it reports:
    1. Do the table and every mapped slug exist (`listFields`), with the expected field type?
    2. Does a one-record `listRecords` have the documented shape (`items`, `total_pages`, `current_page`)?
    3. Does `getRecord` on that record have the documented shape (`item`)?
    4. What comes back for a missing record id and for a missing table id? This settles plan 02's 404 question.
  - It prints a pass/fail table and any slugs it found but you haven't mapped, to help fill the mapping file.
  - It never prints credentials or record values, only field names, types and counts.

Update and delete response shapes can't be confirmed read-only. The adapter already accepts an empty or 204 answer, and plan 04's first deployed write logs the real shape.

## Infrastructure (`template.yaml`, `samconfig.toml`)
- **New parameter `AllowLiveWrites`** (`'true'` | `'false'`, no default) and a condition `LiveWrites`.
  - Globals `FIELDFLOW_ALLOW_LIVE_WRITES: !If [LiveWrites, '1', '0']`.
  - `samconfig.toml`: prod gets `AllowLiveWrites=true`; dev gets `true` (option A) or `false` (option B).
- **No new resources and no IAM change yet.**
  - The SSM read permission and `External: ['@aws-sdk/*']` arrive with the first function that loads secrets (plan 04). Per infra review, that permission is an inline `ssm:GetParameters` on the four exact parameter ARNs, each with `!Sub`, rather than `SSMParameterReadPolicy`, which also grants `ssm:DescribeParameters` on `*` and every secret of the stage. The snippet is in the `new-lambda` skill.
  - The AWS-managed `aws/ssm` key needs no extra `kms:Decrypt` grant. infra-reviewer confirms this on the plan 04 changeset.
- **Data safety:** no stateful resources added or changed.

## Widgets (`widgets/`)
None.

## Platform setup (`docs/tadabase-setup.md`)
Native steps, written for someone new to Tadabase:

1. **App and plan:**
   - The plan must be Pro or higher, which outgoing webhooks need.
   - Option A: duplicate the app for dev.
2. **Tables and fields:** each field gets its exact type, and the logical names the mapping file uses.
   - **Customers:** name, email, phone, address.
   - **Technicians:** name, email, color.
   - **Jobs:**
     - title, description, scheduled date
     - customer → Customers, technician → Technicians
     - status: Scheduled / In Progress / Completed / Invoiced
     - signature (long text, holds the image data URL)
     - total: a formula, the sum of its job items' line totals
   - **Job Items:**
     - job → Jobs
     - description, quantity, unit price
     - line total: a formula, quantity × unit price
   - **Invoices:** job → Jobs, number, issued date, amount, PDF link.
3. **Native first:**
   - Totals are formula fields, and status changes use native record rules where possible.
   - The guide notes what each later plan adds, and why the platform can't do it natively.
4. **API key:**
   - Create it under Settings → API Keys.
   - Keep the app id, key and secret in your local `.env` for the check script, and in SSM for AWS.
   - Includes the `aws ssm put-parameter --type SecureString` commands, run by you.
5. **Field slugs:** run the check script, which lists every table and field with its slug. Then fill in `config/tadabase.<stage>.json`.
6. **Webhooks:**
   - The guide covers the pattern only: POST, a JSON template with `{record_id}`, and the `X-FieldFlow-Secret` header.
   - Each webhook's exact trigger and filter is added by the plan that consumes it.

## Tests
- **`tests/lib/secrets.test.js`:**
  - one `GetParameters` call with all four names and `WithDecryption`
  - a missing parameter throws an error naming it, without leaking any value
  - caching:
    - served from cache within the TTL
    - reloaded after the TTL
    - a failure is not cached
  - the real client is never constructed in tests
- **`tests/lib/schema.test.js`:**
  - the dev and prod mapping files validate
  - a missing required field, a bad slug, a duplicate slug or an unknown stage each throws
  - `toLogical` and `toSlugs` round-trip
- **`tests/lib/runtime.test.js`:**
  - builds a platform whose writes are refused unless the config allows them
  - reuses config and schema across calls
  - a secrets failure gives an error without values
  - `AWS_SAM_LOCAL` keeps writes off
- **Contract and adapter tests:** `listFields` on both adapters; the URL and auth headers for Tadabase.
- **`tests/scripts/tadabase-check.test.js`** (against the fake Tadabase):
  - a pass report for a matching mapping
  - each mismatch is reported: missing table, missing slug, wrong type, unexpected shape
  - unmapped slugs are listed
  - **every request is a GET**
  - the output contains no credential or record value
- **`tests/infra/template.test.js`:**
  - `FIELDFLOW_ALLOW_LIVE_WRITES` comes from the `LiveWrites` condition
  - prod's samconfig sets `AllowLiveWrites=true`
  - dev's value matches the option you pick

## Verification
1. `verify` skill, then `review-diff`. Code-reviewer and security-auditor review the change; infra-reviewer covers `template.yaml` and `samconfig.toml`.
2. **You run the read-only check** against your app, in your own terminal. Claude can't read `.env`, by design.

   ```
   node --env-file=.env scripts/tadabase-check.js dev
   ```

   Expected:
   - every mapped table and slug shows "ok"
   - the list and get shapes show "ok"
   - the 404 behavior is printed

   Paste the output back, and I'll record the confirmed shapes in the plan and in CLAUDE.md's API notes.

## Review (review-diff, 2026-10-28)
The three reviewers found no critical or high issues. Fixed:
- **Check script:**
  - It could report "OK" without confirming the page count. It also couldn't show the real response keys when they differed from the docs, and that is its main job.
  - Now the adapter requires `total_pages` instead of defaulting it, because `listAll` would otherwise stop after page 1.
  - Unexpected shapes throw a `PlatformError` that carries the key names (never values), and the script prints them.
  - A missing record's answer is reported by shape only.
  - Odd field types no longer crash it.
  - Auto Increment is accepted for the invoice number.
- **Secrets:** one SSM client per container, with 1 s / 2 s timeouts and 2 attempts. Concurrent loads share one call. Fail-closed after expiry is documented and tested.
- **Schema:**
  - Duplicate table ids and bad or duplicate slugs in extra fields are rejected.
  - Table lookups use own properties only (`__proto__`).
  - `toSlugs` returns a 400 for an unknown field.
- **Guide:**
  - `AWS_REGION` is set for the SSM commands.
  - Values are read with `read -rs`, so they stay out of shell history.
  - Two keys per app: a read/write key only in SSM, and a read-only key for the local `.env`.
  - No `--key-id`.
- **`new-lambda` skill:** a scoped inline `ssm:GetParameters` on the four ARNs, each with `!Sub`, instead of `SSMParameterReadPolicy` (which grants `DescribeParameters` on `*`, and every secret of the stage).
- **Tests:**
  - they no longer depend on the committed mapping being a placeholder, so filling it in won't break the suite
  - distinctive fake credentials, checked for leaks in every mode
  - unexpected-shape cases

## Follow-ups
- **Verification step 2 is still open.** Shipped before the Tadabase apps exist. You then:
  1. run `node --env-file=.env scripts/tadabase-check.js dev` (discover mode)
  2. fill in `config/tadabase.dev.json` and set `"placeholder": false`
  3. run the script again (check mode)
  4. record the confirmed response keys and 404 behavior in CLAUDE.md's API notes

  Then the same for prod. Deployed functions refuse to start on a placeholder mapping, so this has to happen before plan 04's first deploy.
- Update and delete response shapes get confirmed by plan 04's first deployed write.

## Commits after approval
- `feat(functions): add SSM secrets, field mapping, runtime and read-only Tadabase check`: `lib/`, `config/`, `scripts/tadabase-check.js` and their tests.
- `chore(infra): make live writes a per-stage parameter`: `template.yaml`, `samconfig.toml`, `tests/infra/`.
- `docs: add the Tadabase setup guide`: `docs/tadabase-setup.md`, CLAUDE.md, `.env.example`.
- `docs: mark 03 plan done`.
