# 06 — Kanban board (native)

**Status:** Done (live checks on the dev app pending, see Platform setup)
**Commits:** `5f3e04a` (functions), `9592e58` (docs)

## Goal
A board of jobs in columns by Status, where dragging a card moves the job to that status. It's for
the office (every job) and, optionally, for each technician (their own jobs).

**This is now native.** The roadmap planned a custom widget plus a proxy Lambda, on the
assumption that Tadabase had no kanban with drag-to-update. It does: the Kanban component shows
records as cards in columns by a dropdown field, and dragging a card updates that field, respects
permissions, and runs record rules
([docs](https://docs.tadabase.io/onboarding/article/2207---advanced-components)). Its forum said
drag was unreleased as of May 2025
([thread](https://community.tadabase.io/t/kanban-drag-drop-functionality/2390)). The user checked
the dev app on 2026-10-28: dragging works.

So, following "build natively first", this plan writes no Lambda and no widget. It documents the
native setup, puts guard rails around the two statuses the board must not set casually, and removes
what the custom board had needed.

Out of scope:
- Any custom board, proxy endpoint, CORS, or browser-to-Lambda auth. These were the riskiest
  parts of the old plan, and they're no longer needed.
- Native action buttons on cards ("Start", "Complete"). They were the fallback if drag didn't
  work; they're listed as optional below, for phones.

## Decisions
- **Native Kanban component on Jobs, grouped by Status.** Cards show Title, Customer, Scheduled
  Date and Technician. Columns: `Scheduled`, `In Progress`, `Completed`, `Invoiced`, in that order.
- **The board is not a back door around the invoice flow.** Two statuses have side effects:
  - **Completed** fires the job-completed webhook (plan 04), which invoices the job. Dropping a
    card here skips the Complete job form, and with it the customer's signature (plan 05).
  - **Invoiced** is set by a record rule when an invoice is created. Setting it by hand marks a
    job invoiced with no invoice.
  - Native rule, in order of preference, confirmed in the builder (live check 2):
    1. If the Kanban lets you choose which columns accept drops, **Completed** and **Invoiced**
       accept none. They're shown, but you can't drag a card into them.
    2. Otherwise, the board shows only **Scheduled** and **In Progress**, and a native table under
       it lists Completed and Invoiced jobs. Jobs reach Completed only through the Complete job
       form.
- **Dragging back out of Completed is harmless for invoicing.** If a job is moved back to In
  Progress and completed again, the webhook fires again. `generate-invoice` finds the existing
  invoice (its idempotency claim, plus the existing-invoice check) and answers 200 without
  creating a second one. Plan 04's tests already cover this.
- **Who can drag:** the board's edit permission goes to the office role and to technicians only. The
  customer role (if any) never sees it.
- **Technician's own board (optional):** the same component, filtered to jobs whose Technician is the
  logged-in user. That needs a native connection from Technicians to Users, which the code doesn't
  use and doesn't map. If you skip it, technicians use the office board.
- **Drop `technicians.color`.** It existed only to color the custom board's cards. The native board
  colors columns by stage, and no code reads the field. It comes out of `REQUIRED_FIELDS`, both
  mapping files and the setup guide, so it's one less field to create. A `color` field already in
  the app is simply ignored.
- **No new dependencies, no AWS change.**

## Review (review-diff, 2026-10-28)
code-reviewer and security-auditor found no high issues. The fixes changed some of the decisions
above, and these replace them:

- **The invoice function now requires a signature** (security, medium; the user chose this).
  `generate-invoice` checked only that Status was Completed, so the board's guard rails, which are
  browser-side settings not yet checked live, were all that stood between a drag and an unsigned
  invoice. Now:
  - `lib/invoice.js` `hasSignature`: a PNG data URL under 100 KB, the same rule as the signature
    pad's `isSignature`. A widget test keeps the two in sync.
  - After the Completed check and the existing-invoice check, a job without one gets
    `422 job has no signature`, before any side effect. It isn't stored, so once the job is signed
    and saved again, the next delivery invoices it.
  - Signature is **required** on the Complete job form (no longer optional).
- **Guard rails both ways** (both reviewers, medium): option 1 now locks Completed and Invoiced
  against dragging cards *out* as well as in. If the builder can only block drops into a column,
  use option 2.
- **Re-completing, corrected** (both reviewers, medium): a job pulled back out and completed again
  never gets a second invoice. But its invoice isn't updated, and the job doesn't return to
  Invoiced, because the record rule fires only when an invoice is created. Within the 30-day
  idempotency window the webhook replays the original 201, and after that it answers
  `200 { duplicate: true }`. (The decision above said "answers 200"; that was wrong for the first
  30 days.) Invoice corrections are a manual office task; void and re-issue isn't built.
- **No Status dropdown on the Complete job form** (security, low): the form sets Status to
  Completed itself, so it can't offer Invoiced. New live check: no form or table lets anyone set
  Invoiced by hand.
- **The finished-jobs table (option 2) is read-only** (security, low).
- **The technician board is recommended,** and the office board kept to the office role (security,
  low). Otherwise every technician can see and move every job.
- **Cards show nothing editable,** and never Signature (security, info).
- **Tests:** five 422 cases (none, empty, text, SVG, over 100 KB), signing after a 422 then
  invoices, and `hasSignature` parity with the widget.
- **Not changed:** tables in a mapping that aren't in `REQUIRED_FIELDS` aren't validated (security,
  info). This predates the plan, and the mapping is committed config, not input. It's listed as a
  follow-up.

## Follow-ups
- Invoice corrections: void and re-issue an invoice when a job changes after invoicing.
- Validate every table in a mapping file, not only the required ones (`lib/schema.js`).

## Lambda functions (`functions/`, `lib/`)
- `lib/schema.js`: remove `color` from `REQUIRED_FIELDS.technicians`.
- `config/tadabase.dev.json` and `config/tadabase.prod.json`: remove `technicians.fields.color`.
  Both still hold placeholders, so nothing live changes.

No handler changes.

## Infrastructure (`template.yaml`)
None.

## Widgets (`widgets/`)
None.

## Platform setup (`docs/tadabase-setup.md`)
- Section 2, Technicians: remove the Color row.
- New section **9. Kanban board (plan 06)**:
  1. On an office page, add a **Kanban** component: table Jobs, grouped by Status, columns in the
     order above, with card fields Title, Customer, Scheduled Date and Technician.
  2. Guard rails: Completed and Invoiced don't accept drops (option 1), or the board shows only
     Scheduled and In Progress plus a table of finished jobs (option 2).
  3. Permissions: only the office and technician roles can drag.
  4. Optional: a technician page with the same board, filtered to "Technician is the logged-in
     user" (this needs a Technicians → Users connection).
  5. Optional, for phones, where dragging is awkward: native action links on each card, such as
     "Start" (Status → In Progress). Don't add a "Complete" action: completing goes through the form.
  6. Live checks on the dev app:
     1. Dragging Scheduled → In Progress updates the job (reload the page: it stays moved).
     2. A card can't be dropped into Completed or Invoiced (option 1), or those columns aren't on
        the board (option 2).
     3. Signed in as a role without permission, cards can't be dragged.
- "What stays custom" table: the kanban row moves out, since the board is native.

README:
- The native vs custom table: the kanban board becomes **Native** (the Kanban component, drag to
  update Status).
- The intro example "drag-and-drop board" goes.
- The roadmap row is renamed.

## Tests
- `tests/lib/schema.test.js` and `tests/scripts/tadabase-check.test.js` still pass without
  `technicians.color`. Add one schema case: a mapping that still has `color` (an extra mapped field)
  is accepted, so a mapping file filled in before this change doesn't break.
- No new handler or widget tests: there's no new code.

## Verification
1. `verify` skill, then `review-diff` (code-reviewer; security-auditor because `lib/` changed).
2. In the **dev** app (the user): the three live checks in section 9, step 6.

## Commits after approval
- `feat(functions): drop the unused technicians.color mapping`: `lib/schema.js`, `config/`, tests.
- `docs: native kanban board in the setup guide and README`.
- `docs: mark 06 plan done`.
