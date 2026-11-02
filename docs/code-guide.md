# FieldFlow code guide

A map of the project: what it does, how the pieces fit, where each thing lives in the code, and
how to find your way around. Read it top to bottom once; after that, use the
"Where do I look when..." table at the end. For the short pitch, see [overview.md](overview.md).

---

## 1. The project in one minute

**FieldFlow** is a job tracker for a field-service business (plumbers, HVAC, electricians).
A job goes through four statuses:

```
Scheduled  →  In Progress  →  Completed  →  Invoiced
```

The app itself is built in **Tadabase** (a low-code platform: tables, forms, pages, rules).
Code is written **only where Tadabase can't do something**. Teams that work this
way typically split about 70% Tadabase, 30% custom code on AWS.

So there are three kinds of code:

| Kind | Folder | Runs where | Why it exists |
|---|---|---|---|
| **Lambda functions** | `functions/` | AWS, called by Tadabase webhooks | PDF invoices, catching double bookings, sending back jobs that aren't ready |
| **Shared library** | `lib/` | Inside the Lambdas (and the demo) | Money math, PDFs, signed links, talking to Tadabase, exactly-once logic |
| **Widgets** | `widgets/` | In the browser, inside Tadabase pages | A signature pad, and a line total that updates while you type |

Everything else is Tadabase configuration (described in `docs/tadabase-setup.md`), docs, tests,
and Claude Code tooling.

**Current state:** fully built and tested (902 tests), **not deployed**. Going live needs an AWS
account and Tadabase Pro (for webhooks), so plan 08 is deferred until there's a real app to deploy to. The
**local demo** (`npm run demo`) shows everything working without any account.

---

## 2. The big picture

```
┌──────────────────────── Tadabase app (native, no code) ────────────────────────┐
│  Tables: Customers, Technicians, Jobs, Job Items, Invoices                      │
│  Forms (with validation rules), Kanban board, formula fields, record rules      │
│  + 2 widgets pasted into the app's JavaScript settings (signature, line total)  │
│                                                                                 │
│  Outgoing webhooks (Pro plan):                                                  │
│    • Job Status becomes Completed  ──────────┐                                  │
│    • Job created / updated / deleted ────┐   │                                  │
└──────────────────────────────────────────┼───┼──────────────────────────────────┘
                                           │   │   header X-FieldFlow-Secret
                                           ▼   ▼
┌──────────────────────────────── AWS (template.yaml) ───────────────────────────┐
│  HTTP API (API Gateway)                                                         │
│    POST /webhooks/job-schedule  → check-schedule   (flags double bookings)      │
│    POST /webhooks/job-completed → generate-invoice (PDF + Invoices record)      │
│    GET  /invoices/{jobId}.pdf   → invoice-pdf      (serves the PDF, signed link)│
│    GET  /health                 → health           (deploy smoke test)          │
│                                                                                 │
│  S3 bucket (private PDFs) · DynamoDB (exactly-once claims) · SSM (secrets)      │
└─────────────────────────────────────────────────────────────────────────────────┘
          │ the functions read and write Tadabase through its REST API
          ▼
   api.tadabase.io/api/v1
```

The arrows go both ways: Tadabase **calls** the Lambdas (webhooks), and the Lambdas **call back**
into Tadabase's API to read the job and write results (the invoice record, a flag, a send-back).

---

## 3. A job's life, and which code runs at each step

### Step 1: Scheduled (native + `check-schedule`)
- The office creates a job in a Tadabase form: customer, technician, date, **slot**
  (Morning/Afternoon/Evening).
- **Native:** a form validation rule refuses a second job for the same technician, date and slot.
- **Code:** forms are the only place that rule runs. An inline table edit, an import or the API
  skips it. So every create/update/delete of a job fires a webhook to **`check-schedule`**, which
  recomputes conflicts and writes "Double-booked with: …" into the job's **Schedule Conflict**
  field (and clears it once the conflict is gone).

### Step 2: In Progress (native + line total widget)
- The job is moved on Tadabase's **native Kanban board**. (Its docs say drag works natively; *not
  yet confirmed in a live app*. The fallback is native action buttons on each card.)
- The technician adds **line items** (description, quantity, unit price). Tadabase's formula fields
  only update **after save**, so the **line total widget** shows `qty × price` while typing, and warns
  about a price the invoice would reject (e.g. `1.234,50`).

### Step 3: Completed (signature widget + `generate-invoice`)
- The "Complete job" form has a **Signature** field. The **signature pad widget** draws on a canvas
  and puts a PNG data URL into that field; the native form saves it.
- Status becomes **Completed** → webhook → **`generate-invoice`**.

### Step 4: Invoiced (`generate-invoice` + native record rule)
- `generate-invoice` checks that the job is ready (signature, customer, technician, at least one item,
  total matches the items). If so, it:
  1. renders the PDF (`lib/pdf.js`)
  2. stores it in the private S3 bucket as `invoices/<jobId>.pdf`
  3. creates an **Invoices** record with number `INV-<jobId>`, amount and a **signed link**
- **Native record rule:** creating an Invoice sets the job's Status to **Invoiced**.
- If the job **isn't ready**, it's **sent back** to In Progress with the reason in **Invoice Problem**
  ("Not invoiced: job has no line items. Fix it and complete the job again.").

### Opening the PDF (`invoice-pdf`)
- The link looks like `https://…/invoices/<jobId>.pdf?sig=<HMAC>`. `invoice-pdf` checks the HMAC
  and streams the file from S3. Change one character of `sig` → **403**.

---

## 4. Folder by folder

```
fieldflow/
├── functions/          the 4 Lambda handlers (one folder each, one handler.js)
├── lib/                shared code used by the handlers
│   └── platform/       "adapters": how code talks to Tadabase (real or in-memory)
├── widgets/            browser scripts pasted into the Tadabase app
├── config/             Tadabase table/field ids per stage, business details for invoices
├── demo/               the local demo pages
├── scripts/            demo server, sample invoice, smoke test, Tadabase check, secret scan
├── tests/              Vitest tests, mirroring the folders above
├── docs/               overview, setup guide, go-live guide, walkthrough, plans, screenshots
├── template.yaml       AWS SAM: every AWS resource
├── samconfig.toml      SAM deploy settings (dev/prod)
├── .claude/            Claude Code setup: hooks, agents, skills, settings
├── .githooks/          pre-commit (secret scan, lint, tests)
├── .github/workflows/  CI (same checks + sam validate)
└── CLAUDE.md           the rules Claude follows in this repo
```

### 4.1 `functions/`: the Lambda handlers

| File | Route | What it does | Secrets it can read |
|---|---|---|---|
| `generate-invoice/handler.js` (211 lines) | `POST /webhooks/job-completed` | Ready check → PDF → S3 → Invoices record, exactly once; or send-back | all 5 |
| `check-schedule/handler.js` (127) | `POST /webhooks/job-schedule` | Recomputes Schedule Conflict flags for a job and its neighbours | Tadabase keys + webhook secret |
| `invoice-pdf/handler.js` (50) | `GET /invoices/{file}` | Verifies the link signature, returns the PDF | link secret only |
| `health/handler.js` (10) | `GET /health` | `{ ok: true, stage }`, used after a deploy | none |

**Every handler has the same shape** (this is the most important pattern in the repo):

```js
// 1. A factory that takes its dependencies. Tests call this with fakes.
export function createHandler({ platform, schema, secrets, store, storage, ... }) {
  return wrap(async (event, context) => {
    verifySecret(event, webhookSecret);       // 1. auth: X-FieldFlow-Secret header
    const jobId = requireId(parseJsonBody(event), 'recordId');  // 2. validate input
    ...do the work through `platform`...       // 3. work (never field_NN, always logical names)
    return { status: 200, body: {...} };       // 4. JSON answer
  });
}

// 2. The real thing, wired to Tadabase/S3/DynamoDB/SSM. Only AWS runs this.
export const handler = createHandler({
  platform: () => getRuntime().platform(),   // lazy: built on the first request
  ...
});
```

Why the factory: tests and the demo pass **in-memory** fakes, so nothing ever touches the live app.
Only the exported `handler` gets real connections.

#### `generate-invoice` in detail
Read it in this order: `createHandler` (bottom) → `generate()` → `readyInvoice()` → `findInvoice()`.

- **`withIdempotency(store, 'invoice#<jobId>', …)`** wraps the work. If Tadabase delivers the webhook
  twice, the second one either waits (409) or gets the stored answer. See `lib/idempotency.js`.
- **`findInvoice()`** is the safety net: before creating anything, it searches Invoices by job and by
  number `INV-<jobId>`. Even if DynamoDB lost the claim, no second invoice.
- **`readyInvoice()`** throws `HttpError(422, …)` for each missing piece. `generate()` catches *only
  its own* 422s and turns them into a send-back. A Tadabase error that happens to be 422 is a
  `PlatformError`, not an `HttpError`, so it becomes a 502 and never undoes a completion (a review
  finding from plan 07).
- **Time guards:** `MIN_MS_FOR_CREATE` (8 s). If the Lambda is about to time out, it stops *before* the
  create (503, retry) instead of being cut off halfway.
- **`keepClaim`:** if the create call fails, the record may still have been created, so the claim
  isn't released. The retry after the lease finds the invoice through `findInvoice`.
- **`publicBaseUrl()`** builds the PDF link from the API Gateway domain, and accepts only an
  `*.execute-api.<region>.amazonaws.com` domain, so a forged Host header can't redirect links.

#### `check-schedule` in detail
- No idempotency table needed: it **recomputes** the right flag from current data and writes **only
  if it differs**. A repeated webhook, or the update webhook its own write triggers, finds nothing to
  change. That's also what stops it from looping.
- It checks a **group**: the job itself, jobs with the same booking, and jobs whose flag mentions
  this job (it may have moved away or been deleted).
- Bounded per run: `MAX_GROUP` 25 jobs, `MAX_TECHNICIANS` 5, `MIN_MS_LEFT` 6 s. A run that's cut
  short answers 503 and the next delivery finishes it.
- The actual rules are in **`lib/schedule.js`** (pure functions, easy to test).

### 4.2 `lib/`: shared code

Grouped by job:

**HTTP plumbing**
| File | What's in it |
|---|---|
| `http.js` | `wrap()` (every handler; turns thrown errors into JSON responses), `json()`, `parseJsonBody()` (256 KB cap), `header()` |
| `errors.js` | `HttpError` (our own 4xx/5xx), `PlatformError` (Tadabase failed → 502), `toResponse()`. Responses never include stack traces |
| `webhook.js` | `verifySecret()`: compares the `X-FieldFlow-Secret` header in constant time (SHA-256 + `timingSafeEqual`) |
| `validate.js` | `requireId()` and friends |
| `log.js` | JSON logger that redacts secrets |

**Configuration and secrets**
| File | What's in it |
|---|---|
| `config.js` | Reads env: `STAGE` (dev/prod), Tadabase timeout, and `allowLiveWrites` (true **only** if `FIELDFLOW_ALLOW_LIVE_WRITES === '1'`) |
| `secrets.js` | Loads secrets from SSM Parameter Store (`/fieldflow/<stage>/…`), cached for a few minutes |
| `runtime.js` | `getRuntime()`: builds config + schema + secrets + Tadabase adapter once per Lambda container |
| `schema.js` | Maps **logical names** (`jobs.status`) ↔ **Tadabase slugs** (`field_905`). `toLogical()` for reads, `toSlugs()` for writes. `REQUIRED_FIELDS` lists every field the code uses |

> **Why `schema.js` matters:** Tadabase names fields `field_12`, `field_905`… Those ids differ per app
> (dev vs prod). Handlers never write `field_NN`; they write `jobs.status`, and
> `config/tadabase.<stage>.json` says which slug that is.

**Business logic (pure, no I/O, heavily tested)**
| File | What's in it |
|---|---|
| `invoice.js` | `parseMoneyCents()` (strict: `"$1,234.50"` ok, `"1.234,50"` **refused**, never guessed), `parseQuantityMilli()`, `buildInvoice()`, `hasSignature()`, `invoiceNumber()`. All money is **integer cents**: no floating-point surprises |
| `schedule.js` | `bookingKey(job)` = technician + date + slot (only for open jobs); `conflictText()` = "Double-booked with: …" (max 5 ids listed so it always fits) |
| `pdf.js` | Renders the invoice PDF with `pdf-lib` (the only production dependency) |
| `links.js` | `invoiceLink()` / `verifyInvoiceLink()`: HMAC-SHA256 of `invoice:v1:<jobId>` |

**Exactly-once**
| File | What's in it |
|---|---|
| `idempotency.js` | `withIdempotency()` + a DynamoDB store and an in-memory store. Claim (IN_PROGRESS + lease 60 s) → work → COMPLETED (store the answer) or release. `store: false` answers (like "not ready") aren't kept, so the next try re-checks |

**AWS clients**
| File | What's in it |
|---|---|
| `aws.js` | Lazy S3 and DynamoDB clients with timeouts. The AWS SDK comes from the Lambda runtime, not `package.json` |

### 4.3 `lib/platform/`: the adapter (how code talks to Tadabase)

One interface, two implementations:

```
index.js     the interface (documented in comments): listRecords, listAllRecords, getRecord,
             createRecord, updateRecord, deleteRecord, listTables, listFields
tadabase.js  the real REST client (api.tadabase.io). Refuses ALL writes unless allowLiveWrites
             is true. Timeouts, no redirects, errors become PlatformError
memory.js    an in-memory fake with the same behaviour, for tests and the demo.
             Records every call, can be told to fail the next call
shared.js    rules both share: id format, filter operators, page size, paging
```

`tests/lib/platform/contract.test.js` runs **the same test suite against both**, so the fake can't
drift away from the real one.

### 4.4 `widgets/`: browser code inside Tadabase

Plain scripts (no build step, no framework). You paste them into Tadabase's JavaScript settings and
mount them from a page component's callback (`widgets/README.md` has the snippets).

| File | Edit mode / what it does | Notes |
|---|---|---|
| `signature-pad.js` + `.css` | Draws on a canvas, writes a PNG data URL into the form's Signature input. **View mode** shows a saved signature as an image | Never calls an API; the native form saves it |
| `line-total.js` + `.css` | Shows `qty × price` live, and a hint for an invalid amount | Its money rules are a copy of `lib/invoice.js` (a plain script can't import); a test checks they agree |

Widget rules (CLAUDE.md): no secrets, **no `innerHTML`** with data (enforced by ESLint), safe to mount
twice, visible loading/empty/error states.

### 4.5 `config/`
- `tadabase.dev.json`, `tadabase.prod.json`: table ids and field slugs. Currently **placeholders**
  (`"placeholder": true`), so a deployed function refuses to run until they're filled in from
  `scripts/tadabase-check.js`.
- `invoice.json`: business name, address, currency, time zone printed on invoices (also a placeholder).

### 4.6 `template.yaml`: AWS resources

| Resource | What it is | Notes |
|---|---|---|
| `HttpApi` | API Gateway HTTP API | Throttling: 10/s, burst 20 by default; job-schedule 2/s, burst 5 |
| `HealthFunction`, `GenerateInvoiceFunction`, `InvoicePdfFunction`, `CheckScheduleFunction` | The 4 Lambdas | Node 24, bundled with esbuild. Timeouts 10–25 s (always under the 60 s lease) |
| `…Role` (one per function) | IAM roles | Least privilege: each reads only its own SSM secrets, S3 and DynamoDB actions |
| `InvoicesBucket` + policy | Private S3 for PDFs | Retained, encrypted, no public access |
| `IdempotencyTable` | DynamoDB | TTL on `expiresAt` |
| `…LogGroup` | CloudWatch logs | 30-day retention |

**Data safety:** every stateful resource has `DeletionPolicy: RetainExceptOnCreate` and
`UpdateReplacePolicy: Retain`, so a bad deploy or `delete` never wipes invoices.
`tests/infra/template.test.js` fails the build if that changes, and
`tests/infra/stateful-resources.json` lists the properties that would force a replacement.

### 4.7 `scripts/`
| Script | What it does |
|---|---|
| `demo-server.js` | The local demo (see section 5) |
| `sample-invoice.js` | `npm run demo:invoice` → writes `sample-invoice.pdf` (Northwind Field Services, fictional) |
| `tadabase-check.js` | **Read-only**: lists a live app's tables/fields and checks the mapping. Run by a person, never by tests |
| `smoke-test.js` | After a deploy: hits `/health` and checks unauthenticated requests are refused |
| `scan-secrets.sh` | Secret scan used by pre-commit, verify and CI |

### 4.8 `tests/`
Mirrors the source: `tests/functions/`, `tests/lib/`, `tests/widgets/` (jsdom), `tests/hooks/`
(the Claude safety hooks), `tests/infra/` (template rules), `tests/scripts/`, plus the demo tests.

- `tests/setup.js` **blocks every network connection** that isn't localhost, and Vitest blanks the
  Tadabase and AWS credentials. A test can't reach the live app even by mistake.
- Run: `npm test` (all), `npx vitest run tests/functions/generate-invoice.test.js` (one file).

---

## 5. The local demo, and how it fakes Tadabase

```bash
npm install
npm run demo        # → http://127.0.0.1:5173
```

| Real (same code that deploys) | Stand-in |
|---|---|
| `generate-invoice`, `invoice-pdf`, `check-schedule` (their `createHandler`) | Tadabase → `lib/platform/memory.js` |
| everything in `lib/` (money, PDF, links, idempotency) | S3 → a `Map` |
| both widgets | DynamoDB → `createMemoryStore()` |
| | The **board and job page** → `demo/app.html/app.js/app.css`, a stand-in for Tadabase's native Kanban and forms (labelled on the page) |
| | Tadabase's webhooks, record rule and formula fields → simulated in `scripts/demo-server.js` |

How `scripts/demo-server.js` works:
- `createDemo()` seeds customers, technicians and jobs, builds the three handlers with in-memory
  dependencies and random secrets.
- When the page changes a job (`POST /api/jobs/<id>/move|reschedule|items|complete`), the server
  updates the in-memory record, recomputes formula fields, then calls the handlers **as Tadabase's
  webhooks would**, with the `X-FieldFlow-Secret` header. After an invoice is created it applies the
  "Status → Invoiced" record rule.
- `GET /api/state` returns everything for the page, including the log of every webhook and answer
  (the "Behind the scenes" panel).
- Safety: binds to 127.0.0.1 only, Host allowlist, POST must be JSON and same-origin, a serial queue
  for changes, caps of 50 items per job / 500 total.

There's also an older page, `demo/index.html` (+ `demo.js`, `demo.css`), from plan 05: just the two
widgets on a fake form. Open it straight from the file system.

---

## 6. Safety: what stops things going wrong

**In the code**
- Live writes off by default (`FIELDFLOW_ALLOW_LIVE_WRITES=1` only in the deployed stack).
- Webhook secret checked first in every webhook handler (constant time).
- Exactly-once invoices: DynamoDB claim + a search for an existing invoice.
- Strict money parsing in cents; a total that doesn't match its items stops the invoice.
- Private PDFs behind HMAC-signed links.

**In AWS**
- One IAM role per function, least privilege. Secrets in SSM, never in code.
- Stateful resources retained on delete/replace, enforced by tests.

**For Claude Code** (see section 8)
- Hooks block destructive commands, secret reads, AWS writes and deploys.

**In git**
- Pre-commit: secret scan + lint + tests. CI: the same + `npm audit` + `sam validate`.

---

## 7. Everyday commands

| Command | What it does |
|---|---|
| `npm install` | Install deps; also installs the pre-commit hook |
| `npm run demo` | Local demo at http://127.0.0.1:5173 |
| `npm run demo:invoice` | Write `sample-invoice.pdf` |
| `npm test` | All tests |
| `npm run lint` | ESLint |
| `npm run verify` | Everything: secret scan, lint, tests + coverage, npm audit, sam validate |
| `npm run build` | `sam build` (needs the SAM CLI) |

---

## 8. The Claude Code setup (`.claude/` + `CLAUDE.md`)

How the project was built, and the guard rails Claude worked within.

- **`CLAUDE.md`**: project rules: build natively first, the handler order, idempotency, no
  `field_NN` in handlers, tests never touch the live app, commit format `type(scope): summary`.
- **Hooks** (`.claude/hooks/`, run automatically on every tool call):
  - `guard-bash.py`: blocks destructive git, secret reads, AWS writes, `sam deploy` (except a
    changeset preview), curl writes to Tadabase. Parses quotes and `bash -c`/`$(…)`; fails closed.
  - `protect-files.py`: blocks reading `.env`, keys, `~/.aws`; asks before editing the guard rails.
  - `post-edit-check.sh`: lint + related tests after every JS edit.
  - `only-tests*.`: keep the test-writer agent inside `tests/`.
  - Their behaviour is pinned by `tests/hooks/hooks.test.js`.
- **Agents** (`.claude/agents/`): `code-reviewer`, `security-auditor`, `infra-reviewer` (read-only),
  `test-writer`.
- **Skills** (`.claude/skills/`): `plan-task` (write a plan, stop for approval), `review-diff` (run
  reviewers in parallel), `verify`, `ship-plan`, `new-lambda`, `safe-deploy` (changeset →
  infra-reviewer → a person executes it).

**The workflow every feature followed:**
`plan-task` → a person approves → build → `verify` → `review-diff` → fix findings → `ship-plan` (commit,
plan → Done).

---

## 9. The plans (`docs/plans/`): the project's history

| # | Plan | Status | In one line |
|---|---|---|---|
| 01 | Claude Code safety tooling | Done | Hooks, agents, skills, CLAUDE.md |
| 02 | Scaffold: SAM, adapters, lib | Done | template.yaml, `lib/`, memory + Tadabase adapters, health |
| 03 | Tadabase setup, live wiring | Done | Schema mapping, SSM secrets, runtime, `tadabase-check.js` |
| 04 | generate-invoice | Done | PDF, S3, signed links, idempotency, invoice-pdf |
| 05 | Signature pad + live total widgets | Done | The two widgets + `demo/index.html` |
| 06 | Native Kanban board | Done | Decided to configure Tadabase's Kanban instead of coding one |
| 07 | Job checks | Done | Slots, double booking (`check-schedule`), send-back. HubSpot sync dropped |
| 08 | Go-live | **Deferred** | `docs/go-live.md` runbook; needs an AWS account and Tadabase Pro |
| 09 | Local client demo | Done | `npm run demo`, screenshots, sample PDF, overview |

Each plan file has the decisions, review findings (what the reviewers caught) and the commits.

---

## 10. The other docs

| File | Who it's for |
|---|---|
| `README.md` | Anyone landing on the repo: demo, screenshots, native vs custom, setup |
| `docs/overview.md` | Anyone evaluating the project: one page |
| `docs/tadabase-setup.md` | Step-by-step builder clicks: tables, fields, forms, rules, webhooks, widgets |
| `docs/go-live.md` | Deploying for real: AWS account, profiles, first deploy, live checks |
| `docs/walkthrough.md` | A 15-minute tour **in the live app** after go-live (not the code) |
| `widgets/README.md` | How to install the widgets in Tadabase |

---

## 11. Things that are not confirmed yet

- **Native Kanban drag** in Tadabase: documented, **not tested** in a live app.
- Tadabase API response shapes, 404 behaviour, filtering a connection field by id, `contains` on Text,
  writing a Drop Down value. `scripts/tadabase-check.js` and setup guide section 10 check these.
- Nothing has run against a real Tadabase app or AWS account yet.

---

## 12. Where do I look when…

| Question | Look at |
|---|---|
| How does an invoice get created? | `functions/generate-invoice/handler.js` → `generate()` |
| Why wasn't a job invoiced? | `readyInvoice()` in the same file; the job's Invoice Problem field |
| How are double bookings found? | `lib/schedule.js`, then `functions/check-schedule/handler.js` |
| How is money parsed / rounded? | `lib/invoice.js` (`parseMoneyCents`, `buildInvoice`) |
| What does the PDF look like / how is it drawn? | `lib/pdf.js`; `npm run demo:invoice` |
| How are retries made safe? | `lib/idempotency.js` |
| How does the code talk to Tadabase? | `lib/platform/tadabase.js` (real), `memory.js` (fake) |
| Which Tadabase field is `jobs.status`? | `config/tadabase.<stage>.json`, via `lib/schema.js` |
| Where do secrets come from? | `lib/secrets.js` (SSM), `lib/runtime.js` |
| Who's allowed to call a webhook? | `lib/webhook.js` (`X-FieldFlow-Secret`) |
| How are PDF links secured? | `lib/links.js`, `functions/invoice-pdf/handler.js` |
| What AWS resources exist, and their permissions? | `template.yaml` |
| How does the demo fake Tadabase? | `scripts/demo-server.js` |
| What does the signature widget do? | `widgets/signature-pad.js`, `widgets/README.md` |
| Why is something native and not code? | README "native vs custom", `docs/overview.md` |
| Why was a decision made? | The plan in `docs/plans/` |
| What is Claude allowed to do? | `CLAUDE.md`, `.claude/hooks/guard-bash.py` |

---

## 13. Suggested reading order (about an hour)

1. `docs/overview.md` (5 min): the pitch.
2. Run `npm run demo`, click through a job end to end, watch "Behind the scenes" (10 min).
3. `functions/health/handler.js` (1 min): the smallest handler, shows the factory pattern.
4. `lib/http.js` + `lib/errors.js` (5 min): how every request/error is handled.
5. `functions/generate-invoice/handler.js` (15 min): the core. Bottom to top.
6. `lib/invoice.js` + `lib/idempotency.js` (10 min).
7. `lib/schedule.js` + `functions/check-schedule/handler.js` (10 min).
8. `tests/functions/generate-invoice.test.js` (5 min): see how the memory adapter is used.
9. `CLAUDE.md` + skim `.claude/` (5 min): how it was built.
