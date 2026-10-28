# 07 — Job checks

**Status:** Done (live checks pending, after the deploy in plan 08)
**Commits:** `a8c320d` (functions), `daf712b` (functions), `0e16f13` (infra), `7390f21` (docs)

## Goal
Checks that keep jobs consistent, each as native as Tadabase allows:
1. **Form checks** (native only): required fields, no past dates on new jobs, positive quantities
   and prices.
2. **No double-booking.** Jobs get a time slot, and no two jobs share technician + date + slot.
3. **Complete only when ready.** A job the invoice function can't invoice is **sent back**: its
   Status returns to In Progress, and an Invoice Problem field says why.

Out of scope:
- **CRM contact sync.** The roadmap had "contact sync" here. The user doesn't use a CRM yet, so it
  moves to a later plan (see Follow-ups; the HubSpot design is kept there).
- Start-time/duration scheduling (the user chose slots).
- Reworking invoices after a send-back.

Why custom: native validation rules run only when a form is submitted. They can't count a job's
line items, and the docs don't say they apply to board drags, inline edits, imports or the API
([Validation Rules](https://docs.tadabase.io/automation-rules/article/validation-rules)). Composite
unique constraints across every entry point are still
"[coming soon](https://docs.tadabase.io/updates/article/unique-constraints-coming-soon)". So the
forms do what they can natively, and two small server checks cover the other entry points.

## Decisions
- **Slots:** a new Jobs field, **Slot** (Drop Down: `Morning`, `Afternoon`, `Evening`). A booking
  is technician + Scheduled Date + Slot.
- **Double-booking is checked twice:**
  - **Native, before saving:** a validation rule on every job form: Technician "is not unique", with
    *Check Additional Fields* set to Scheduled Date and Slot. This blocks the save with a message.
    Live gate 1 confirms that a Date and a Drop Down can be additional fields.
  - **Server, after saving** (`check-schedule`): catches what slips past forms (board drags,
    inline edits, imports, the API). It can't block a save; it **flags** both jobs in a new
    **Schedule Conflict** field (`Double-booked with: <jobId>, ...`), and clears the flag once the
    conflict is gone.
- **`check-schedule` is idempotent by construction, without a claim:**
  - It computes each flag from the current data, and writes only when the value would change.
  - So a repeated delivery, or the webhook that its own write fires, finds nothing to change and
    stops. That's also the **loop guard**: its writes fire Jobs update webhooks, and those must
    converge.
  - A DynamoDB claim would only turn parallel deliveries into 409s. This is a documented exception
    to the `withIdempotency` convention: the function has no non-repeatable side effect.
- **Stale flags:**
  - When job A moves or is deleted, the job it was double-booked with still names A.
  - So `check-schedule` re-checks A's new booking group, plus every job whose Schedule Conflict
    `contains` A's id. A false match (`job4` in `job42`) only costs a re-check.
  - Bounded to 25 jobs and the usual page and time limits.
- **Which jobs count as booked:** only open jobs (Scheduled, In Progress). The query filters by
  technician and status; date and slot are compared in code. That keeps the query small, and it
  doesn't depend on Tadabase's date filter format, which isn't confirmed yet.
- **Send-back (in `generate-invoice`):**
  - The "fix the job" 422s now also update the job: `status: In Progress`, `invoiceProblem:
    <reason>`. These are: no signature, no customer, **no technician (new)**, no line items, more
    than 200 items, an unreadable amount, and a Total mismatch.
  - The write is idempotent (the same values every time), and the result isn't stored, so a
    corrected job is invoiced when it's completed again.
  - If the write fails, the answer is 502 and the claim is released, so a retry writes it again.
  - Setting In Progress doesn't fire the job-completed webhook (filtered to Completed), so there's
    no loop.
  - After an invoice is created, a non-empty Invoice Problem is cleared. That's best effort: it's
    skipped when time is short and logged on failure, and it never fails the invoice.
- **New mapped fields** (in `REQUIRED_FIELDS`, the mapping files, the setup guide and the check
  script):
  - `jobs.slot` (select)
  - `jobs.invoiceProblem` (long text)
  - `jobs.scheduleConflict` (text)
- **No new dependencies and no new secrets.**

## Lambda functions (`functions/`, `lib/`)
- **`functions/generate-invoice/handler.js`:**
  - Add the "no technician" 422.
  - Wrap the readiness checks so that a 422 sends the job back, then returns
    `{ store: false, value: 422 { error, sentBack: true } }`.
  - Clear Invoice Problem after a create.
- **`functions/check-schedule/handler.js`** (`POST /webhooks/job-schedule`, body `{recordId}`):
  1. `verifySecret` → 401; `requireId` → 400.
  2. `getRecord(jobs, id)`. A missing job (deleted) only re-checks the jobs that name it.
  3. Build the group to re-check: the job, the open jobs of its technician, and the jobs whose
     `scheduleConflict` contains its id.
  4. For each job in the group, compute its conflict text. Write `updateRecord(jobs, id, {
     scheduleConflict })` only when it changes.
  5. Return `200 { checked, updated, conflicts }`.
- **`lib/schedule.js`** (pure): `bookingKey(job)`, and
  `conflictText(job, others) → '' | 'Double-booked with: id1, id2'`.
- **`lib/schema.js`, config:** the three new fields.

## Infrastructure (`template.yaml`)
- **`CheckScheduleFunction`:** `POST /webhooks/job-schedule`, `Timeout: 25`.
  - Its role: its own log group, and the four Tadabase and webhook SSM parameters.
- **`CheckScheduleLogGroup`:** `RetainExceptOnCreate` / `Retain`, with 30-day retention. It gets
  appended to `tests/infra/stateful-resources.json` (approved with this plan).
- **Output:** `JobScheduleWebhookUrl`.
- **Unchanged:** no change to existing resources or their logical ids, and `generate-invoice`'s
  role is unchanged (the job update goes through the Tadabase API, with the same keys).

## Widgets (`widgets/`)
None.

## Platform setup (`docs/tadabase-setup.md`)
- **Section 2, the new Jobs fields:** Slot (Drop Down), Invoice Problem (Long Text), Schedule
  Conflict (Text).
- **New section 10, "Job checks (plan 07)":**
  1. **Form validation rules:**
     - Job forms: Title, Customer, Technician, Scheduled Date and Slot are required, and a new job's
       Scheduled Date can't be in the past.
     - Job Items forms: Quantity > 0, Unit Price ≥ 0.
     - Double-booking: Technician "is not unique", checking the additional fields Scheduled Date and
       Slot.
  2. **Show the flags:** Invoice Problem and Schedule Conflict on the job details page and on board
     cards, read-only everywhere. Optionally, a "Problems" table filtered to either field not empty.
  3. **Webhook:** Jobs, on create, update and delete → `JobScheduleWebhookUrl`, with
     `X-FieldFlow-Secret` and the body `{"recordId": "{record_id}"}`.
  4. **Live gates (dev app):**
     1. The double-booking validation rule accepts Date and Drop Down as additional fields, and
        blocks a second booking.
     2. A Drop Down value written through the API (`In Progress`) is accepted.
     3. A double booking made by dragging or inline editing gets flagged within seconds, and the flag
        clears when one job moves.
     4. Completing a job with no line items sends it back to In Progress with the reason.

README: the native vs custom table (form checks native; the schedule check and send-back custom),
features, and the 422 / send-back behavior. The roadmap's CRM sync moves to "Later".

## Tests
- **`tests/functions/generate-invoice.test.js`:**
  - each readiness 422 sends the job back (status and reason written, nothing created, result not
    stored), then it's invoiced after the fix
  - the send-back write failing gives 502 and releases the claim
  - "no technician" gives 422
  - Invoice Problem cleared after a create; a failed clear doesn't fail the invoice
- **`tests/functions/check-schedule.test.js`:**
  - 401, 400
  - a conflict flags both jobs; no conflict writes nothing; moving a job clears its old partner's
    flag (the `contains` path); a deleted job clears its partners
  - Completed and Invoiced jobs don't count; the same slot on another date or for another
    technician doesn't count
  - running twice writes nothing the second time (the loop guard)
  - an upstream error gives 502; the group is capped at 25
- **`tests/lib/schedule.test.js`:** booking keys, the conflict text, and the order of ids.
- **`tests/lib/schema.test.js`, `tests/scripts/tadabase-check.test.js`:** the new fields.
- **`tests/infra/template.test.js`:** the new function, role and log group follow the rules
  (`Retain`, exact SSM ARNs, timeouts).

## Verification
1. `verify` skill, then `review-diff` with all three reviewers (`template.yaml` changes).
2. After the deploy (plan 08), in the **dev** app: the live gates in section 10, step 4.

## Review (review-diff, 2026-10-28)
code-reviewer, security-auditor and infra-reviewer found no critical or high issues. Infra:
data-safe. The changeset should only add resources (the function, its role and log group, its
route and permission), with nothing removed or replaced. The fixes changed some of the decisions
above, and these replace them:

- **The send-back only reacts to this function's own "not ready" errors** (code + security,
  medium). It checked `status === 422`, which also matched a `PlatformError` carrying Tadabase's own
  422. That would have undone a valid completion and written "listRecords failed with status 422"
  into Invoice Problem. Now it's `instanceof HttpError`; an upstream 422 is a 502 with no write.
  Tests cover `getRecord` and `listRecords`.
- **The conflict text is capped** (security, medium): at most 5 ids, then "and N more". The loop
  guard depends on Tadabase returning exactly what was written, and a value the field shortens
  would loop forever. New live check 5.4.
- **Bounds per delivery** (all three reviewers):
  - At most 5 technicians' job lists are read per run. Members beyond that are skipped and logged,
    and their own next update re-checks them.
  - The run stops itself with 6 s left (503, safe to retry).
  - `POST /webhooks/job-schedule` gets its own route throttle: rate 2, burst 5, below the default
    10/20, with a template test. Reserved concurrency was suggested instead, but it fails to deploy
    on accounts with a low concurrency limit, so the route throttle does the job.
  - `MemorySize: 256` is now explicit.
- **The job is compared in its list shape** (code, low): when the job appears in its technician's
  list, that copy is used, so a get/list format difference can't hide a conflict.
- **`getRuntime` refuses different `secretKeys`** in one container (security, info).
- **Unconfirmed filters** (code, medium): the check relies on `is` on a connection field and
  `contains` on text. Both are added to CLAUDE.md's "not confirmed" list and to live checks 5.2
  and 5.3 (delete, technician change). The memory adapter can't prove the connection case.
- **Documented, not changed:**
  - Clearing the flag of a just-completed job fires the invoice webhook a second time (409 or a
    replay; never a second invoice).
  - Old Completed jobs with no invoice get invoiced or sent back on their next update. The setup
    guide's step 4 says to find them before turning the webhook on.
  - A fix-and-recomplete within a second or two of a send-back can race; completing once more
    fixes it.
- **Not changed:** a minimum length for record ids (security, low). The real Tadabase id format
  isn't confirmed. The per-run caps above bound the cost of a short id instead.
- **Tests:**
  - an upstream 422 is not a send-back
  - a write failing partway, then a re-run
  - a technician change
  - running out of time
  - the technician cap
  - the text cap
  - the route throttle
  - `getRuntime` refusing different secrets

## Follow-ups
- **CRM contact sync (HubSpot), when a CRM is in use.** The design, so a later plan can start
  from it:
  - **Native first:** check whether Tadabase Pipes can create *and* update a HubSpot contact from a
    record rule on Customers. The native Databridge only pulls HubSpot data in.
  - **Otherwise, a `sync-hubspot` Lambda** on a Customers create/update webhook.
    - With a stored HubSpot id: `PATCH /crm/v3/objects/contacts/{id}`, falling back to the upsert
      on 404.
    - Without one: `POST /crm/v3/objects/contacts/batch/upsert` by email.
    - The id is written back to a `customers.hubspotId` field, only when it changes (the loop
      guard).
    - A small `lib/hubspot.js` client with live-write protection.
    - A per-stage token in `/fieldflow/<stage>/hubspot/token`.
    - Dev uses a free HubSpot developer test account.

## Commits after approval
- `feat(functions): send back jobs that aren't ready to invoice`
- `feat(functions): check schedules for double-booking`
- `chore(infra): add the check-schedule function`
- `docs: job checks in the setup guide and README`
- `docs: mark 07 plan done`
