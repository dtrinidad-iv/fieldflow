# 09 — Local client demo, sample invoice and overview page

**Status:** WIP

## Goal
Show FieldFlow to a client **without paying for anything**: no AWS account, no paid Tadabase plan.
Three pieces:
1. **`npm run demo`**: a localhost web app that runs the **real** function code (`generate-invoice`,
   `invoice-pdf`, `check-schedule`) and the real widgets, against an in-memory stand-in for
   Tadabase. The client sees the whole flow working: board, line items with a live total,
   signature, a real PDF invoice, a send-back, and a double-booking flag.
2. **A sample invoice PDF** with fake data, to attach or show.
3. **A one-page client overview**: what FieldFlow does, the architecture, native vs custom,
   and how it's built safely. Published as a private, shareable page.

Out of scope:
- Any change to the production functions or the template. The demo wraps them; it doesn't fork
  them.
- Hosting the demo publicly. It runs on your laptop, on `127.0.0.1` only.
- The real Tadabase UI. The demo's page is a plain stand-in, clearly labeled as such.

Why: the user wants to present the stack to a client, and plan 08 (going live) costs money: AWS
needs a card, and outgoing webhooks need Tadabase Pro. **Plan 08 is deferred**, unchanged and
ready for when a client pays for a real deployment.

## Decisions
- **Real code, stand-in platform.** The demo server builds each handler with `createHandler`, as
  the tests do:
  - `createMemoryPlatform`, seeded with demo customers, technicians, jobs and items
  - a schema built from `REQUIRED_FIELDS`
  - `createMemoryStore` for idempotency
  - an in-memory file store for PDFs
  - random per-run webhook and link secrets
  - demo business details (Northwind Field Services, a fictional company)
- **It plays Tadabase's part.** After each change the page makes, the server does what the real
  app would:
  - it calls `check-schedule` (the Jobs webhook)
  - when Status becomes Completed, it calls `generate-invoice` (the job-completed webhook), with
    the secret header
  - when an invoice is created, it applies the record rule (Status → Invoiced)
  - its own writes re-trigger `check-schedule`, at most 5 rounds, as in the app
- **PDF links stay real.** `generate-invoice` only accepts an execute-api domain, and that check
  stays. The server passes a fixed stand-in domain (`demo.execute-api.us-east-1.amazonaws.com`).
  The page opens the link's path and signature on `localhost`, where the real `invoice-pdf`
  handler verifies the signature and serves the PDF.
- **The page** (`demo/app.html`, `demo/app.js`, `demo/app.css`) follows the widget rules: a plain
  browser script, no `innerHTML` (lint enforces it), all text set with `textContent`.
  - **Board:** columns by Status. Drag between Scheduled and In Progress; Completed and Invoiced
    are locked, like the real board's guard rails.
  - **Job panel:**
    - details
    - Slot (editable, to show a double booking)
    - line items, with the real line-total widget
    - Complete job, with the real signature pad
    - Invoice Problem and Schedule Conflict flags
  - **Invoices list:** with PDF links.
  - A banner: "Local demo: real FieldFlow code, in-memory stand-in for Tadabase. Nothing leaves
    this laptop."
- **Server:** `scripts/demo-server.js`, `node:http` only, no new dependencies.
  - It listens on `127.0.0.1` (port 5173, or `PORT`).
  - It serves only a fixed list of static files (the demo page and the widgets), so no path from
    the request reaches the file system.
  - Request bodies are JSON, capped at 256 KB.
  - **Reset** reloads the seed data.
  - It never talks to Tadabase or AWS: no credentials are read, and the memory adapter has no
    network.
- **Sample invoice:** `npm run demo:invoice` writes `sample-invoice.pdf` (gitignored) with the
  real renderer and fake data. It's also available from the demo page.
- **Overview page:** an Artifact (a private page you can share by link), written after the demo
  works so it can link to the walkthrough. It names no real client.
- **`npm run demo` in `package.json`**, and a README section "Run the demo".

## Lambda functions (`functions/`, `lib/`)
None changed.

## Infrastructure (`template.yaml`)
None.

## Widgets (`widgets/`)
None changed. The demo page mounts them, like `demo/index.html` does.

## Platform setup (`docs/tadabase-setup.md`)
None.

## Tests
`tests/demo-server.test.js` starts the server on a random localhost port (allowed by
`tests/setup.js`):
- **Static files:** `GET /` serves the page. Only listed files are served:
  `/../package.json` and `/%2e%2e/...` give 404.
- **Completing a signed job with items:** an invoice is created, the job becomes Invoiced, and
  the PDF link serves a real PDF (`%PDF-`). A wrong `sig` gives 403.
- **Completing a job with no items:** it's sent back to In Progress with the reason, and no
  invoice is created.
- **Double booking:** setting two jobs to the same technician, date and slot flags both; moving
  one clears both.
- **Locked statuses:** the board API refuses moving a card into or out of Completed or Invoiced.
- **Bad input:** a bad JSON body or an unknown job id gives 400 or 404, and an oversized body gives
  413.
- **Reset:** restores the seed data.
- **Address:** the server listens on 127.0.0.1 only.

`tests/demo-app.test.js` (jsdom): the page builds the board from a faked state endpoint, with
record text rendered as text.

## Verification
1. `verify` skill, then `review-diff` (code-reviewer and security-auditor).
2. Run `npm run demo`, open `http://127.0.0.1:5173`, and run the walkthrough's flow:
   - drag a card
   - double-book (both flagged)
   - add items (live total)
   - complete unsigned (refused), then signed (invoice, then Invoiced)
   - open the PDF
   - complete with no items (sent back)

## Review (review-diff, 2026-10-28)
code-reviewer and security-auditor found no high issues. code-reviewer checked every "what to
try" step in the README against the seed data. The fixes changed some of the decisions above, and
these replace them:

- **The formula fields are no longer rounded** (code, medium). The demo computed Line Total and
  Total with the invoice's own half-up rounding, so `generate-invoice`'s "Total must match the
  items" check could never fail in the demo, even where production would send the job back. They
  now follow the setup guide's formulas (Quantity * Unit Price; the sum), so a fractional-cent job
  is sent back, as it would be live. Test added.
- **Other sites can't drive the demo** (security, medium). The Host allowlist stopped DNS
  rebinding, but a page in another tab could still send a "simple" POST to 127.0.0.1. Now:
  - every POST must be `application/json` (415 otherwise), which forces a CORS preflight the
    server never answers
  - a foreign `Origin`, or `Sec-Fetch-Site: cross-site`, gets 403
  - the page sends JSON for every POST, Reset included
- **One change at a time** (code, low): every mutating action, Reset included, runs through one
  queue. A Reset in the middle of a Complete (the PDF render yields to the event loop) can no
  longer leave a fresh job "Invoiced" with no invoice.
- **It never crashes on an error** (code, low): only the demo's own 4xx errors pass through.
  Anything else, including a `PlatformError` with status 0, is a 500, and the error path itself is
  guarded.
- **Limits** (security, low): 50 items per job and 500 in total, and a signature over 100,000
  characters is refused before it's stored. The platform's call log is cleared after each change,
  so memory stays flat during a long demo.
- **400 instead of 500** for a malformed `%`-escape in an invoice path, or a non-string or
  malformed technician id (code + security, low).
- **The page:**
  - a drawn but unsubmitted signature survives the panel being rebuilt
  - clicking the open card doesn't rebuild the panel, and focus returns to the card
  - dropping a card on its own column does nothing
  - invoice links are accepted only as `/invoices/<id>.pdf` on the page's own origin (security,
    defense in depth)
- **`PORT=80`** also accepts the bare host (code, low). The startup promise can't become an
  unhandled rejection.
- **Tests:**
  - cross-site POSTs (415, 403)
  - the fractional-cent send-back
  - a sent-back job completed again: invoiced, problem cleared
  - the item cap and the signature cap
  - malformed input
  - Reset during Complete
  - Reset clearing flags and the log
  - the page's invoice link

## Screenshots
The Playwright MCP server (as in saas-starter) would let Claude capture README screenshots, but
adding `.mcp.json` was refused: Claude Code's permission check treats it as Claude giving itself a
new tool, which is a reasonable rule. The user can add it with
`claude mcp add --scope project playwright -- npx -y @playwright/mcp@0.0.83 --headless --isolated --output-dir .playwright-mcp`,
or take the screenshots by hand into `docs/screenshots/`. The README gets them when they exist.

## Commits after approval
- `feat(widgets): add a local client demo running the real functions in memory`: the
  `demo/app.*` files, `scripts/demo-server.js`, `scripts/sample-invoice.js`, `package.json`,
  `.gitignore`, tests.
- `docs: run the demo, and plan 08 deferred`: README, plans index.
- `docs: mark 09 plan done`.
- The overview page is published as an Artifact (no commit).
