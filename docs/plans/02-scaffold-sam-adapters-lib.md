# 02 — Scaffold: SAM template, platform adapters, shared lib

**Status:** Done
**Commits:** `a4c6c81` (functions), `bda3fb6` (infra), `41d291d` (claude)

## Goal
Lay the foundation every later Lambda builds on:
- the shared request/response/error/webhook code in `lib/`
- the platform adapter interface, with an in-memory adapter for tests and a Tadabase REST adapter
- a SAM template and `samconfig.toml` that deploy one `GET /health` function behind an HTTP API

It also adds the template test promised in plan 01, so the `Retain` policies and stable logical ids are enforced from the first resource on.

Out of scope:
- Loading secrets from SSM, the field-slug mapping, and wiring handlers to the live app: plan 03.
- Idempotency storage and the S3 bucket: plan 04, when the first side effect appears.
- CORS and widgets: plans 05 and 06.

Why custom: the platform has no server-side code. Every later Lambda needs the same auth, validation, error and API-client code. Writing it once, with tests, keeps each handler small.

## Decisions
- **HTTP API (`AWS::Serverless::HttpApi`), not REST API:** cheaper and simpler, and it supports route throttling. We need none of the REST-only features.
- **Runtime:** `nodejs24.x` on `arm64`, which is cheaper at the same speed. ES modules. (First shipped as `nodejs20.x`; the first CI `sam validate` flagged it as deprecated since 2026-04-30, with creation disabled from 2027-02-01, so a follow-up commit moved everything to Node 24.)
- **Region:** `us-east-1` by default, set in `samconfig.toml`. Change it there if you prefer another.
- **Stages:** `dev` and `prod` as `samconfig.toml` config envs. Stacks are `fieldflow-dev` and `fieldflow-prod`, with a `Stage` parameter. Every deploy section keeps `confirm_changeset = true`.
- **No production dependencies.** Node 24 has `fetch`, `AbortSignal.timeout` and `crypto.timingSafeEqual`. Validation is a few small helpers in `lib/validate.js`, not a schema library.
- **New dev dependencies (approved):**
  - **`esbuild`:** SAM's `BuildMethod: esbuild` bundles each function with only the `lib/` code it imports. `CodeUri` is the repo root (functions import `../../lib`), but only the bundle ships, not the repo.
  - **`yaml`** (eemeli/yaml, no dependencies): parses `template.yaml` with its CloudFormation tags (`!Ref`, `!Sub`, `!GetAtt`) for the template test. A regex check would be easy to fool.
- **Tadabase API response shapes** (`items`, `item`, `recordId`, `total_pages`) come from docs.tadabase.io. Plan 03 confirms them with a read-only GET against the live app before any handler relies on them.
- **`/health` has no webhook secret:** it returns only `{ ok, stage }`, with no data and no platform calls. It is the smoke-test target for the `safe-deploy` skill.

## Lambda functions (`functions/`, `lib/`)

### `lib/errors.js`
- `HttpError(status, message)`, plus the helpers `badRequest`, `unauthorized`, `notFound`, `payloadTooLarge`.
- `PlatformError(status, operation)`, thrown by adapters for upstream failures. It never carries the upstream response body.
- `toResponse(err, log)`:
  - an `HttpError` returns its own status and message
  - a `PlatformError` becomes `502 { error: "upstream platform error" }`
  - anything else becomes `500 { error: "internal error" }`

  The full error goes to the log; no stack traces go in responses.

### `lib/http.js`
- `json(status, body)`: sets `content-type: application/json` and `cache-control: no-store`.
- `parseJsonBody(event)`:
  - handles base64 bodies
  - over 256 KB gives 413
  - invalid JSON, or anything that isn't an object, gives 400
- `header(event, name)`: case-insensitive lookup.
- `wrap(fn, { log })`: runs `fn(event)` and turns thrown errors into responses through `toResponse`. Every handler uses it.

### `lib/webhook.js`
- `verifySecret(event, expected)`: compares the `X-FieldFlow-Secret` header, constant-time, using `timingSafeEqual` on SHA-256 digests so lengths never leak.
- A missing or wrong header gives 401.
- An empty `expected` (misconfiguration) also gives 401, and the config error is logged: it fails closed.

### `lib/validate.js`
Small validators that throw `badRequest` with the field name: `requireString(obj, key, { max })`, `optionalString`, `requireId`, `requireEnum`, `requireNumber({ min, max })`.

### `lib/log.js`
- A JSON line logger with `info`, `warn` and `error`.
- It redacts keys matching `secret|key|token|password|authorization`, so a logged event or config can't leak credentials.

### `lib/config.js`
- `readConfig(env)` returns:
  - `stage`
  - `allowLiveWrites` (`FIELDFLOW_ALLOW_LIVE_WRITES === "1"`, nothing else)
  - `tadabase: { baseUrl, timeoutMs }`
- It validates the values and throws on a bad stage.
- No secrets here yet. Plan 03 adds the SSM loader.

### `lib/platform/`
Adapter interface (documented with JSDoc in `index.js`), all async:
- `listRecords(tableId, { filters, page, limit })` returns `{ items, page, totalPages }`
- `listAllRecords(tableId, { filters, maxPages = 20 })`: bounded pagination. It throws instead of looping forever.
- `getRecord(tableId, recordId)` returns the record, or `null` on 404
- `createRecord(tableId, fields)` returns `{ id }`
- `updateRecord(tableId, recordId, fields)`
- `deleteRecord(tableId, recordId)`

**`memory.js` (`createMemoryPlatform({ seed })`):**
- Stores records in a `Map` per table, with generated ids and simple field filters.
- `calls` records every call, so tests can check, for example, that a duplicate webhook didn't create twice.
- `failNext(method, error)` makes the next call to `method` fail, to test upstream errors.

**`tadabase.js` (`createTadabasePlatform({ appId, appKey, appSecret, baseUrl, timeoutMs, allowLiveWrites, fetch })`):**
- Requests:
  - Builds the request URLs from CLAUDE.md's API notes, encoding the table and record ids.
  - Sends the three auth headers on every request.
- Failure handling:
  - Times out each request with `AbortSignal.timeout(timeoutMs)`.
  - Maps any non-2xx to `PlatformError`.
- Writes:
  - Create, update and delete throw `Live writes are disabled` unless `allowLiveWrites` is set.
  - That check happens before any request, which is the last line of the plan 01 live-data defense.
- `fetch` is injectable for tests.

### `functions/health/handler.js`
- `createHandler({ config })` returns a handler for `GET /health`, which answers `200 { ok: true, stage }`.
- `handler` is wired to `readConfig(process.env)`.

## Infrastructure (`template.yaml`, `samconfig.toml`)

**`template.yaml`:**
- `Globals`:
  - runtime `nodejs24.x`, `arm64`
  - timeout 10 s, memory 256 MB
  - environment `STAGE`, `FIELDFLOW_ALLOW_LIVE_WRITES: "1"` (the deployed stack is the only place it's set; `readConfig` ignores it under `sam local`, where `AWS_SAM_LOCAL=true`), and `NODE_OPTIONS: --enable-source-maps`
- `Parameters`: `Stage` (`dev` | `prod`).
- `HttpApi`: `AWS::Serverless::HttpApi` with `DefaultRouteSettings` throttling (burst 20, rate 10/s, per route) and an access log group.
- `HealthFunction`:
  - `CodeUri: ./`, `Handler: handler.handler`
  - `Metadata: BuildMethod: esbuild`, with entry point `functions/health/handler.js`, format esm, `.mjs` output, target `node24`, a source map, and no minifying (readable stack traces)
  - `LoggingConfig: { LogFormat: JSON, LogGroup: !Ref HealthLogGroup }`
  - event `GET /health`
  - no policies beyond the basic execution role
- `HealthLogGroup` (`/fieldflow/${Stage}/health`) and `HttpApiAccessLogGroup` (`/fieldflow/${Stage}/http-api-access`):
  - `AWS::Logs::LogGroup` with 30-day retention
  - `DeletionPolicy: RetainExceptOnCreate` (a failed first deploy doesn't leave orphans that block the next one) and `UpdateReplacePolicy: Retain`
  - named per stage, so dev and prod can share an account
- `Outputs`: `ApiUrl`.
- Data-safety check: the only stateful resources are the two log groups, pinned in `tests/infra/stateful-resources.json` with their names. There are no renamed ids, since this is the first template.

**`samconfig.toml`:**
- `[default.global.parameters]`: `stack_name = "fieldflow-dev"`
- `[dev.deploy.parameters]` and `[prod.deploy.parameters]`, each with:
  - `confirm_changeset = true`
  - `capabilities = "CAPABILITY_IAM"`
  - `resolve_s3 = true`
  - `region = "us-east-1"`
  - `parameter_overrides = "Stage=dev"` (or `prod`)
  - `stack_name`
- `[*.build.parameters]` and `[*.validate.parameters]` with `lint = true`.

## Widgets (`widgets/`)
None.

## Platform setup (`docs/tadabase-setup.md`)
None. Plan 03 covers the API key and the tables.

## Tests
- **`tests/lib/errors.test.js`:** each error type maps to its status; 502 and 500 responses contain no upstream body or stack.
- **`tests/lib/http.test.js`:**
  - JSON and base64 bodies
  - 400 for invalid JSON, a non-object body, or an empty body
  - 413 for an oversized body
  - case-insensitive headers
  - `wrap` turns thrown errors into responses
- **`tests/lib/webhook.test.js`:**
  - the right secret passes
  - wrong, missing, different-length or wrong-case-header secrets give 401
  - an empty configured secret gives 401
- **`tests/lib/validate.test.js`:** each validator's pass and fail cases, with the field name in the message.
- **`tests/lib/log.test.js`:** nested secret-looking keys are redacted.
- **`tests/lib/config.test.js`:** defaults; `allowLiveWrites` is true only for exactly `"1"`; a bad stage throws.
- **`tests/lib/platform/contract.test.js`:** one shared suite run against both adapters, the Tadabase one over a stubbed `fetch` that serves a fake table.
  - create, get, update, delete and list
  - `getRecord` returns null for a missing id
  - pagination, and `listAllRecords` stopping at `maxPages`
- **`tests/lib/platform/tadabase.test.js`:**
  - Requests:
    - exact URLs, with ids encoded
    - the three auth headers
    - a POST body for updates
  - Write guard:
    - writes throw before `fetch` is called when `allowLiveWrites` is false
    - reads still work
  - Failures:
    - a timeout aborts the request
    - non-2xx gives a `PlatformError` without the body
  - The real network is never reached (`tests/setup.js` would fail the test).
- **`tests/lib/platform/memory.test.js`:** `failNext`, `calls` and seeding.
- **`tests/functions/health.test.js`:** 200 with the stage; a thrown config error becomes a 500 with no detail.
- **`tests/infra/template.test.js`** (the plan 01 follow-up):
  - Data safety:
    - every resource of a stateful type (`AWS::S3::Bucket`, `AWS::DynamoDB::Table`, `AWS::Logs::LogGroup`, `AWS::SSM::Parameter`, ...) has both `Retain` policies
    - a pinned list of stateful logical ids is still present; renaming one fails the test
  - IAM: no `*` action or resource in any policy.
  - Runtime:
    - every function has a timeout, memory and a log group with retention
    - the HTTP API has throttling
  - Deploy config: every `*.deploy.parameters` section of `samconfig.toml` has `confirm_changeset = true`.
- Coverage thresholds from `vitest.config.js` (80% lines and functions, 75% branches) now apply to `lib/` and `functions/`.

## Verification
1. `verify` skill → `ALL PASSED`. `sam validate --lint` is **skipped locally**: the SAM CLI isn't installed here (`brew install aws-sam-cli` to add it). CI runs it on the template.
2. `review-diff`: code-reviewer, security-auditor (`lib/`, `functions/`, `package.json`) and infra-reviewer (`template.yaml`, `samconfig.toml`).
3. With the SAM CLI installed (optional):
   1. `sam build` creates `.aws-sam/build/HealthFunction/handler.mjs` containing only the health code and the `lib/` it imports.
   2. `sam local invoke HealthFunction` (needs Docker) returns `{"ok":true,"stage":"dev"}`.

No deploy in this plan. The first deploy is plan 08, through `safe-deploy`.

## Review (review-diff, 2026-10-28)
code-reviewer, security-auditor and infra-reviewer found no critical or high issues. Fixed:
- **Adapters:**
  - Ids are validated before they go into a URL. Before, an empty or `undefined` record id built the collection URL, so an update became a create; `.` and `..` resolved likewise.
  - Redirects are refused, so the auth headers can't follow one.
  - The write guard requires exactly `true`.
  - An unexpected response shape is an error, not an empty result.
  - An empty 204 is accepted for update and delete.
  - Memory now matches Tadabase:
    - page size capped at 100
    - unknown tables rejected
    - filter operators checked up front
  - `listAllRecords` has an 8 s time budget, and `TADABASE_TIMEOUT_MS` is capped at 8000, both inside the 10 s Lambda timeout.
  - The shared rules moved to `lib/platform/shared.js` (no import cycle).
- **Config and logging:**
  - `sam local` never gets live writes (`AWS_SAM_LOCAL`).
  - Log redaction covers more key names, and fields can't overwrite `level` or `message`.
- **Validators:** `optionalString` treats whitespace as absent; `requireNumber` accepts plain decimals only.
- **Template:**
  - Log groups use `RetainExceptOnCreate`.
  - The pinned resources live in an append-only file, which needs your approval to edit, and include the properties that force a replacement.
  - Unknown resource types fail the test, and the IAM checks are stricter.
- **Build:** `prepare` no longer fails outside a git repo (`sam build` copies the repo without `.git`); CI now runs `sam build`.
- **Tests:**
  - the timeout test now fails if no abort signal is passed
  - the health test uses a non-default stage
  - the contract suite covers `maxPages`, unknown tables, bad ids and page-size caps
- **Guard:** a backslash-escaped backtick no longer trips it.

## Follow-ups
- **Plan 03 decision:** dev and prod both have `FIELDFLOW_ALLOW_LIVE_WRITES=1`. Use a separate Tadabase app (or credentials) per stage under `/fieldflow/${Stage}/...` in SSM, or turn live writes off for dev.
- Plan 03's read-only shape check should also confirm:
  - what a 404 means for a missing record versus a wrong table
  - what an update or delete returns
- The basic execution role allows `logs:*` writes on `*`, through a managed policy. Give functions an explicit role scoped to their own log group when the first function with real permissions arrives (plan 04).
- Never log a whole API Gateway event (redaction goes by key name); log the ids you need.

## Commits after approval
- `feat(functions): add shared lib, platform adapters and health function`: `lib/`, `functions/health/` and their tests.
- `chore(infra): add SAM template, samconfig and template safety test`: `template.yaml`, `samconfig.toml`, `tests/infra/`, and `package.json` / lockfile for the dev dependencies.
- `docs: mark 02 plan done`.
