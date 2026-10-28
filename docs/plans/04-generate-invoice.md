# 04 — Generate invoice Lambda

**Status:** Done (live end-to-end test in plan 08, see Follow-ups)
**Commits:** `fa3d8c3` (functions), `b401c05` (infra), `1e1fb38` (docs)

## Goal
When a job is marked **Completed** in Tadabase, a webhook calls a Lambda that does four things:
1. reads the job, its customer and its line items
2. renders a PDF invoice and stores it privately in S3
3. creates the matching Invoices record in the app, with the amount and a stable link to the PDF
4. does all of this exactly once, however many times the webhook is delivered

Out of scope: emailing the invoice, taxes and discounts, editing or voiding invoices, and the deploy itself (plan 08).

Why custom: Tadabase can't render a PDF from a template on the server side, and has no private file storage reachable through its API. Everything around it stays native: the Completed status change, the totals (formula fields), the Invoices table, and moving the job to `Invoiced` when an invoice is connected (a record rule).

## Decisions
- **Trigger:** a Tadabase outgoing webhook on Jobs, on record update, filtered to Status = `Completed`.
  - It sends `POST /webhooks/job-completed` with the `X-FieldFlow-Secret` header and the body `{"recordId": "{record_id}"}`.
  - The function re-reads the job through the API rather than trusting payload fields. If the job isn't Completed by then, it answers `200 { skipped }`.
- **Exactly once, with a DynamoDB idempotency table (`IdempotencyTable`):**
  - **Claim:** a conditional `PutItem` on `invoice#<jobId>` marks the job IN_PROGRESS, with a 60 s lease.
  - **Duplicate delivery:**
    - a delivery that finds the work COMPLETED gets the stored result back
    - one that finds it IN_PROGRESS with a live lease gets `409`, and Tadabase can retry later
  - **Failure:** the claim is deleted, so a retry can proceed.
  - **Safety net:** a job that already has a connected Invoices record (for example one created by hand) is never invoiced again.
  - Small helper code (`lib/idempotency.js`), no library.
- **Invoice number:** `INV-<year>-<jobId>`.
  - It's deterministic, so a retry produces the same number and the same S3 key.
  - That means `invoices.number` is a Text field. The setup guide drops the Auto Increment option.
- **PDF storage: S3 plus a stable signed link.**
  - Storage:
    - The private `InvoicesBucket` holds `invoices/<jobId>.pdf`.
    - The bucket is versioned and encrypted, blocks all public access, and accepts TLS only.
  - The link:
    - `invoices.pdfLink` holds `GET /invoices/<jobId>.pdf?sig=<hmac>`.
    - A second small function checks the HMAC (constant-time) and answers `302` with a presigned S3 URL that is valid for 5 minutes.
    - The link stays valid indefinitely, and only someone who has it can open the PDF. A direct presigned URL would stop working within hours, since Lambda credentials are short-lived.
  - The HMAC key is a fifth SSM SecureString, `/fieldflow/<stage>/link-secret`. Rotating it breaks old links, and the guide says so.
- **New production dependency (needs your OK): `pdf-lib`.**
  - It has no native code, it's MIT-licensed and widely used, and esbuild bundles it.
  - It uses the standard PDF fonts, so no font files ship. Text outside their character set is replaced, not allowed to crash the function.
  - The alternative, hand-writing PDF syntax, is fragile and harder to review.
- **Business details on the invoice** (name, address, currency) go in `config/invoice.json`. You fill them in; they aren't secrets. Amounts are calculated in integer cents.
- **Explicit IAM roles per function**, picking up the plan 02 follow-up.
  - Each function writes logs only to its own log group.
  - Each gets only the S3, DynamoDB and SSM actions its code uses, on exact ARNs. No `*` anywhere.
- **AWS SDK clients:** S3, the S3 presigner and DynamoDB come from the SDK in the Lambda runtime, marked `External` like SSM. Every client gets short timeouts.

  `@aws-sdk/s3-request-presigner` is **not** in the runtime. It's needed only by the link function, so it's bundled and becomes a second production dependency (needs your OK). It's the official AWS package, and the alternative is hand-written SigV4 signing.

## Lambda functions (`functions/`, `lib/`)
- **`lib/invoice.js`, pure functions:**
  - `buildInvoice({ job, customer, technician, items, business, issuedAt })` returns `{ number, issuedDate, lines, totalCents, ... }`.
  - Rounding and cents math are explicit.
  - Bad inputs (negative quantity, missing price) are rejected with a clear error.
- **`lib/pdf.js`: `renderInvoicePdf(invoice)`** returns the PDF bytes.
  - It uses pdf-lib with Helvetica.
  - The layout has a header with business details, the invoice number and date, the customer's billing block, the job title, scheduled date and technician, a line-item table that continues onto further pages, and the total.
  - Text that the standard fonts can't encode gets replaced.
- **`lib/idempotency.js`: `withIdempotency(store, key, fn, { leaseMs, ttlDays, now })`**
  - `store` comes in two versions:
    - `createDynamoStore(client, tableName)`: conditional writes, with TTL in `expiresAt`
    - `createMemoryStore()`: for tests
- **`lib/links.js`: `signInvoiceLink(jobId, secret)` and `verifyInvoiceLink(jobId, sig, secret)`**
  - HMAC-SHA256, base64url.
  - Verified with `timingSafeEqual`.
- **`lib/aws.js`: lazy clients** (S3, DynamoDB, presigner) from the runtime SDK, with `maxAttempts: 2` and 1 s / 3 s timeouts.
- **`lib/secrets.js`:** gains `linkSecret` (`/fieldflow/<stage>/link-secret`).
- **`functions/generate-invoice/handler.js`: `createHandler({ platform, schema, secrets, store, storage, business, now, log })`**
  1. Verify `X-FieldFlow-Secret` against `secrets.webhookSecret`. On failure: 401.
  2. Parse the body and `requireId(body, 'recordId')`. On failure: 400.
  3. `withIdempotency(store, 'invoice#' + jobId, ...)`:
     - get the job (404 if missing), and skip with 200 unless its status is `Completed`
     - if any Invoices record is connected to the job, return it with 200 `{ duplicate: true }`
     - get the customer and technician, and `listAllRecords` the Job Items filtered by job
     - `buildInvoice`, then `renderInvoicePdf`
     - `storage.put('invoices/<jobId>.pdf', bytes)`
     - `platform.createRecord(invoices, toSlugs(...))`
  4. Return `201 { invoiceId, number, amount, pdfLink }`, or the stored result for a duplicate delivery.
  5. Upstream errors become 502 (through `wrap`), and the claim is released.

  The native Total is compared with the computed one, and a mismatch is logged as a warning, by id only. The computed total wins.
- **`functions/invoice-pdf/handler.js`: `GET /invoices/{jobId}.pdf?sig=...`**
  1. Validate `jobId` (`requireId`).
  2. Verify the signature, giving 403 when it's missing or wrong.
  3. Check the object exists (`HeadObject`), giving 404 if not.
  4. Answer `302` to a presigned URL valid for 5 minutes, with `cache-control: no-store`.

  No Tadabase call. The link secret is its only secret.

## Infrastructure (`template.yaml`)
- **`InvoicesBucket` (`AWS::S3::Bucket`):**
  - versioning, SSE-S3, all four public-access blocks, `BucketOwnerEnforced`
  - noncurrent versions expire after 90 days
  - `DeletionPolicy: RetainExceptOnCreate`, `UpdateReplacePolicy: Retain`
  - no `BucketName`, so a CloudFormation-generated name that never changes
- **`InvoicesBucketPolicy`:** denies any request without `aws:SecureTransport`.
- **`IdempotencyTable` (`AWS::DynamoDB::Table`):**
  - key `key` (S), on-demand billing, TTL on `expiresAt`, point-in-time recovery
  - `RetainExceptOnCreate` / `Retain`, no `TableName`
- **`GenerateInvoiceFunction`:**
  - 512 MB (PDF rendering), 10 s timeout
  - `POST /webhooks/job-completed`
  - an explicit role with:
    - log writes to its log group
    - `s3:PutObject` on `invoices/*`
    - `dynamodb:PutItem`, `GetItem`, `UpdateItem` and `DeleteItem` on the table
    - `ssm:GetParameters` on the five parameter ARNs
- **`InvoicePdfFunction`:**
  - 256 MB
  - `GET /invoices/{file}`
  - an explicit role with:
    - log writes
    - `s3:GetObject` on `invoices/*` (for the presigned URL and `HeadObject`)
    - `ssm:GetParameters` on the link secret only
- **Log groups:** one per function, 30 days, `Retain`.
- **Outputs:** `JobCompletedWebhookUrl`, `InvoicesBucketName`.
- **Data safety:** five new stateful resources (bucket, table, two log groups, plus the bucket policy, which is stateless). Each one is pinned in `tests/infra/stateful-resources.json`, which needs your approval to edit. Existing ids are unchanged.
- **Template tests:**
  - S3 and DynamoDB join the "known types" list
  - the bucket has versioning, encryption, public-access blocks and a TLS-only policy
  - the table has TTL and point-in-time recovery
  - every function role allows log writes only to its own log group, and no `*`

## Widgets (`widgets/`)
None.

## Platform setup (`docs/tadabase-setup.md`)
- **Invoices:** Number is Text, filled in by the function. Drop the Auto Increment option. The PDF field is a Link.
- **The webhook for this plan:** Jobs, On record update, filter Status is `Completed`.
  - Method and URL: `POST <JobCompletedWebhookUrl>`.
  - Header: `X-FieldFlow-Secret`.
  - Body: `{"recordId": "{record_id}"}`.
- **A record rule** sets Job Status to `Invoiced` when an Invoices record connected to it is created.
- **A fifth SSM parameter:** `link-secret`.
- **Fill in `config/invoice.json`:** business name, address, email and currency.

## Tests
- **`tests/lib/invoice.test.js`:**
  - line and total cents, rounding (0.1 + 0.2), zero items
  - bad quantity or price rejected
  - number format
- **`tests/lib/pdf.test.js`:**
  - the output is a valid PDF: pdf-lib loads it back, and it starts with `%PDF`
  - 40 line items run onto a second page
  - non-Latin text doesn't throw
- **`tests/lib/idempotency.test.js`** (memory store, and the Dynamo store against a fake client):
  - claim, then complete, then replay returns the stored result
  - an in-progress claim with a live lease gives a conflict
  - an expired lease can be taken over
  - a failure releases the claim
  - TTL is set
- **`tests/lib/links.test.js`:**
  - sign, then verify
  - a tampered sig, a different job, or a missing sig fails
  - comparison is constant-time
- **`tests/functions/generate-invoice.test.js`** (memory platform, memory store, fake storage):
  - happy path: the PDF is stored at the right key, and the Invoices record has the right mapped fields, amount and link
  - 401 for a missing or wrong secret; 400 for a bad body or recordId
  - 404 for a missing job; 200 skipped when the job isn't Completed
  - 502 on a platform failure, with the claim released so a retry succeeds
  - **duplicate delivery:** one invoice and one PDF, and the same response both times
  - a concurrent delivery gets 409
  - an existing connected invoice means no new one
  - a total mismatch is logged without values
- **`tests/functions/invoice-pdf.test.js`:**
  - 302 to the presigned URL with no-store
  - 403 for a bad or missing sig
  - 404 for a missing object
  - 400 for a bad id or path traversal
- **`tests/infra/template.test.js`:** the checks listed above.

## Verification
1. `verify` skill (CI also runs `sam validate` and `sam build`), then `review-diff` with all three reviewers.
2. Locally, with no AWS and no live app: a test renders a sample invoice to the scratchpad, so you can open it and check the layout.
3. The live end-to-end test is in plan 08, after the first deploy: mark a dev job Completed, and the dev app gets an Invoices record whose link opens the PDF.

## Review (review-diff, 2026-10-28)
The three reviewers found no critical or high issues. The fixes changed some of the decisions above, and these replace them:

- **Exactly once, hardened.** Before, a failed or timed-out `createRecord` released the claim, and the only duplicate check was a connection filter nobody had confirmed live, so a retry could create a second invoice. Now:
  - the claim is kept once the create has been attempted (`keepClaim`)
  - an existing invoice is also found by its number
  - the create is skipped when less than 8 s of the invocation is left
  - claims carry an owner token, so an old invocation can't complete or release a claim that was taken over
  - a template test checks that the 25 s function timeout stays below the 60 s lease
- **Invoice number is `INV-<jobId>`,** with no year. Retries across midnight or New Year gave a different number. The issue date uses `config/invoice.json` `timeZone`.
- **Money is parsed strictly,** and anything else is a 422:
  - US formats only, at most 2 decimals; `1.234,50` used to be read as 1.23
  - quantities up to 3 decimals
  - line totals in integers, rounding half up
  - a native Total that differs from the line items stops the invoice
- **PDF delivery: no presigner.**
  - The bundled presigner and the runtime's S3 client could drift apart in version.
  - `invoice-pdf` now returns the PDF itself (base64, `private, no-store`, `nosniff`), so `@aws-sdk/s3-request-presigner` is no longer a dependency.
  - `s3:ListBucket` is unconditioned, because a prefix condition never matches GetObject, and missing PDFs would get 403/500 instead of 404.
- **Links:**
  - The signed message is versioned (`invoice:v1:<jobId>`).
  - Only the canonical signature spelling is accepted.
  - The link host must be this region's `execute-api` domain.
- **PDF:** record text is cut to 200 characters before measuring, so one huge field can't time the function out, and there are at most 200 line items.
- **Infra:**
  - generate-invoice `Timeout: 25`
  - `HttpApi` pinned, because its id is part of every stored link
  - no expiry on old PDF versions (financial records)
  - `DeletionProtectionEnabled` on the table
- **Tests:**
  - the three duplicate scenarios at handler level: create-then-fail, `complete()` failing, and the connection filter finding nothing
  - owner-token takeover
  - exact per-row PDF pagination
  - a tamper in the middle of a link signature, plus the non-canonical spellings

## Follow-ups
- **Plan 08 gates, before the webhook is switched on:**
  1. A job-item filter on the job connection returns that job's items (the code re-checks, but an empty answer means no items, which is a 422).
  2. The Invoices record rule fires for records created through the API.
  3. Whether Tadabase retries a webhook after a 5xx or 409, and how often. If it doesn't retry, add a CloudWatch alarm on this function's 5xx and 409 responses, and document "re-save the job".
  4. What a connection or Link field expects on write (`job: jobId`, `pdfLink: URL`).
  5. A missing PDF returns 404, not 403.
  6. Configure the webhook only after the stack reaches UPDATE_COMPLETE.
- A custom domain for the links (a `PUBLIC_BASE_URL` stage parameter), so the links outlive the API id.
- pdf-lib 1.17.1 hasn't had a release since 2021. Keep it on a watch list; it only writes PDFs, never parses untrusted ones.

## Commits after approval
- `feat(functions): add the generate-invoice and invoice-pdf functions`: `lib/`, `functions/`, `config/invoice.json`, tests, `package.json` and the lockfile.
- `chore(infra): add the invoices bucket, idempotency table and function roles`: `template.yaml`, `tests/infra/`.
- `docs: invoice webhook and settings in the setup guide`.
- `docs: mark 04 plan done`.
