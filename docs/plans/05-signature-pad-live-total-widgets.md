# 05 — Signature pad and live total widgets, demo page

**Status:** Done (live checks on the dev app pending, see Platform setup)
**Commits:** `cf061d0` (widgets), `d4d3be1` (docs)

## Goal
Two small browser widgets for the Tadabase app, plus a local demo page to try them without the app:
1. **Signature pad:** on the job's completion form, the customer signs with a finger, pen or
   mouse. The signature is saved by the **native form** into Jobs → Signature, as a PNG data URL.
   On the job details page, the saved signature is shown as an image instead of a long text string.
2. **Live line total:** on the Job Items form, `Quantity × Unit Price` is shown while typing, with
   the same strict number rules the invoice function uses. A price the invoice would reject (for
   example `1.234,50`) is flagged right there, instead of failing later as a 422.

Out of scope:
- Any Lambda, API or AWS change. The widgets read and write nothing outside the form they sit in.
- The signature on the invoice PDF (a follow-up: it changes plan 04's code).
- A running job total across items. The native rollup stays the source of truth and updates on save.
- The kanban board and the proxy Lambda (plan 06).

Why custom: native forms have no drawing input, and equation fields (Line Total) compute only
after the record is saved, so nothing tells the user about a bad amount while they type.

## Decisions
- **The native form does the saving.** The signature widget only fills in the form's own
  Signature (Long Text) input and lets the user press the form's Save button. No widget calls an
  API, so there's no secret, no CORS and no proxy, and Tadabase's own permissions and record rules
  apply as usual. The Lambda-proxy rule for widget writes doesn't come into play: the widget never
  writes anything itself.
- **Plain scripts, no build step.** Each widget is one self-contained file (`sourceType: script`,
  as `eslint.config.js` already sets for `widgets/`), installed by pasting it into the app's
  JavaScript and CSS settings. No hosting, no bundler, no new dependency.
  - Each widget adds itself to `window.FieldFlow` and exposes `mount(element, options)`, which
    returns `{ destroy() }`.
  - The alternative, hosting the files on S3/CloudFront, adds infra and a cache to manage, for
    two small files.
- **Mounting through Tadabase's component callback** in the install snippet:
  `TB.render('component_NN', (data) => FieldFlow.signaturePad.mount(data.ele[0], {...}))`. The
  widget code itself doesn't depend on `TB`, so tests and the demo page call `mount` directly.
  Confirm the callback name and `data.ele` against the live app at install (live gate 1).
- **Fields are found by slug, passed in at install.** Options take the field slug
  (`signatureField: 'field_NN'`), and the widget looks inside its component for
  `[name="<slug>"]`. If that's not found, it shows a visible "field not found" message instead of
  failing silently. The real DOM is confirmed at install (live gate 2). Widgets never hard-code a
  `field_NN`.
- **Safe to mount twice.** `mount` marks the element (`data-fieldflow-mounted`) and returns the
  existing instance on a second call, so a Tadabase re-render never adds duplicate listeners or
  canvases.
- **Signature details:**
  - Pointer Events cover mouse, touch and pen; `touch-action: none` stops the page scrolling
    while signing. The canvas is scaled for `devicePixelRatio`, so lines stay sharp.
  - After each stroke the PNG data URL goes into the Signature input, and `input` and `change`
    events are dispatched so the form framework sees the new value. **Clear** empties both.
  - The original Long Text input is hidden with a CSS class, not removed, so it is still
    submitted with the form.
  - Size cap: 100 KB (a typical signature is 5–20 KB). Over that, the pad shows an error and
    leaves the field unchanged.
  - **View mode** (`mode: 'view'`) on the details page turns the field's text into an `<img>`,
    only if it matches `^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$` and is under the cap.
    Anything else shows as "No signature". A `javascript:` or `https:` value is never used as a
    source.
  - States: "Sign here" (empty), "Signed" (with Clear), and errors such as "This browser can't
    draw here" when the canvas has no 2D context.
- **Line total details:**
  - It listens to `input` on the Quantity and Unit Price inputs, both found by slug.
  - Its money rules match `lib/invoice.js`: US format, at most 2 decimals for prices and 3 for
    quantities, integer math, rounding half up. A widget can't import from `lib/` (it's a
    plain script), so the rules are copied, and a **parity test** runs both versions over the same
    table of inputs. If the two ever disagree, the tests fail.
  - States: "Line total: $1,234.50", nothing while a field is empty, and an inline hint such as
    "Use an amount like 1234.50" when the input is invalid. The hint is for the user only: it
    doesn't block the form.
  - Formatting uses `Intl.NumberFormat`, with the currency and locale passed in as options
    (defaults `USD` / `en-US`, matching `config/invoice.json`).
- **Demo page (`demo/`):** a static `index.html` that mimics a job completion form and a Job Items
  form with fake data, and mounts both widgets. It opens straight from disk (`file://`), so it
  needs no server or dependency. A "Re-render" button re-mounts the widgets to show they're safe
  to mount twice.
- **No new dependencies.** jsdom has no canvas, so tests stub `getContext` and `toDataURL`.
  Adding the native `canvas` package isn't worth the install cost.

## Lambda functions (`functions/`, `lib/`)
None.

## Infrastructure (`template.yaml`)
None.

## Widgets (`widgets/`)
- `widgets/signature-pad.js`: `FieldFlow.signaturePad.mount(el, { signatureField, mode = 'edit', maxBytes = 100_000, height = 200 })`
  - edit mode: canvas, Clear button, status line, and it fills and hides the field's input
  - view mode: shows the field's value as an image, or "No signature"
- `widgets/signature-pad.css`: `ff-sig-*` classes, with a visible focus ring on Clear
- `widgets/line-total.js`: `FieldFlow.lineTotal.mount(el, { quantityField, unitPriceField, currency = 'USD', locale = 'en-US' })`
- `widgets/line-total.css`: `ff-total-*` classes
- `widgets/README.md`: an install snippet for each widget, and how to find a component id and
  field slug in the builder
- `demo/index.html`, `demo/demo.js`, `demo/demo.css`: the local demo

All text goes in with `textContent`. Elements are built with `createElement`, and nothing uses
`innerHTML` (lint enforces it).

## Platform setup (`docs/tadabase-setup.md`)
A new section, **8. Widgets (plan 05)**:
1. Add a **Complete job** form on the job details page, with Signature (Long Text) and Status.
   Optional, native: make Signature required on this form.
2. Paste `widgets/signature-pad.js` and `widgets/line-total.js` into the app's JavaScript settings,
   and the CSS files into its CSS settings. Re-paste when a widget changes.
3. Add the snippets from `widgets/README.md` to the page's JavaScript, with the component ids and
   field slugs (slugs are in `config/tadabase.<stage>.json`).
4. Live checks on the **dev** app (the user, in the browser):
   - Gate 1: `TB.render` fires and `data.ele` is the component element.
   - Gate 2: the inputs carry `name="<slug>"`, and a value set by the widget is saved on Save.
   - Gate 3: Long Text keeps a 100 KB value intact (check that a signature reloads as an image).

README: the features section and the repository layout gain the widgets and the demo. The "native
vs custom" row for plan 05 is already there.

## Tests
`tests/widgets/signature-pad.test.js` (jsdom):
- mounting when the element, or the signature input, is missing shows a visible error, with no throw
- mounting twice returns the same instance, with one canvas and no duplicate listeners
  (a stroke is counted once)
- a pointer stroke writes the data URL to the input and fires `input` and `change`; Clear empties it
- over `maxBytes`: an error, and the input stays unchanged
- no 2D context: an error state, and nothing else breaks
- `destroy()` removes the listeners and the widget's elements, and shows the input again
- view mode: a valid data URL becomes an `<img>`; `javascript:...`, `https://...`, a data URL
  with `<script>` in it, an SVG data URL, or an oversized value all show "No signature" and never
  set `src`
- status text is set as text, not HTML

`tests/widgets/line-total.test.js` (jsdom):
- typing a quantity and a price shows the formatted total
- invalid input shows the hint; an empty field shows nothing
- rounding cases: `0.333 × 0.01`, `1.5 × 0.03`, `2.125 × 4.00`
- missing fields, mounting twice, `destroy()`, and record text rendered as text
- **parity:** a shared table of about 30 price and quantity inputs gives the same accept or reject,
  and the same cents, in the widget and in `lib/invoice.js`

`tests/demo.test.js`: `demo/index.html` loads in jsdom with both widgets mounted, and has no
errors in the console.

## Verification
1. `verify` skill, then `review-diff` (code-reviewer and security-auditor).
2. Locally: open `demo/index.html` in a browser.
   - Sign with the mouse, and with touch in the device toolbar: the hidden field preview fills in;
     Clear empties it.
   - Press Re-render: there's still one pad, and it still works.
   - Type `2.5` and `$1,234.50`: it shows `$3,086.25`. Type `1.234,50`: it shows the hint.
3. In the **dev** app, after installing (the user): run the three live gates above. Then sign a
   test job and save it: the details page shows the signature as an image. Add a job item: the
   total updates while typing, and matches the native Line Total after saving.

## Review (review-diff, 2026-10-28)
code-reviewer and security-auditor found no critical or high issues. The fixes changed some of the
decisions above, and these replace them:

- **Mounting twice, hardened.** A repeat `mount` returns the cached instance only while it's still
  live: its box and inputs are still inside the element and, in view mode, the value is unchanged.
  Otherwise it tears the old instance down and mounts again. This covers Tadabase re-rendering a
  form's contents inside the same component element. Error instances ("field not found") are never
  live, so a later mount recovers once the field appears. The elements are marked with
  `data-fieldflow-signature` and `data-fieldflow-line-total`.
- **The saved value always matches the pad:**
  - An export over the cap clears the input, so an earlier, smaller copy can't be saved.
  - A non-empty value that isn't a valid signature is cleared at mount, so it can't be saved back
    or satisfy a "required" rule.
- **The input is visually hidden (`ff-sig-offscreen`), not `display:none`,** so a native
  "required" check can still focus it and show its message.
- **Canvas:**
  - The canvas is sized again before each stroke while the pad is blank (a popup can be 0 wide at
    mount, and a tablet can rotate).
  - The PNG is exported at 1x, so its size doesn't grow with pixel density.
  - One pointer at a time: a palm or a second finger doesn't join the stroke.
- **View mode reads `.value` only from inputs and textareas,** and `textContent` from anything else
  (an `<li>` has a numeric `.value`).
- **Docs:**
  - Setup step 2 says to lock Signature down to the Complete job form and its roles, since anyone
    who can edit the field can paste in another image.
  - Two more live checks: an unsigned required Save shows a message, and the item inputs aren't
    `type="number"`.
- **Lint:** `srcdoc`, `setHTMLUnsafe`, `createContextualFragment` and `parseFromString` are now
  banned in `widgets/` and `demo/`, ahead of plan 06's board, which renders record data.
- **Tests:**
  - a re-render inside the same element, and recovery from "field not found"
  - an oversized second stroke, and clearing a stray value at mount
  - redrawing a saved signature, pointer scaling, a second pointer, and `pointercancel`
  - the 1x export
  - view mode on an `<li>`, and a value that changes in place
  - the line total's `change` event
  - line math parity with `buildInvoice`
- **Rejected:** capping digit runs for very large amounts. The widget behaves exactly like
  `lib/invoice.js`, and the total is display only. It belongs to the invoice parser, as a follow-up.

## Follow-ups
- Signature on the invoice PDF (plan 04's renderer, with the same data-URL check as view mode).
- If the dev app shows that inputs don't carry `name="<slug>"`, change the lookup to the real
  attribute (a one-line change, plus a test).
- `lib/invoice.js`: cap amounts and quantities at a sane number of digits (about 12), so huge
  values are refused rather than rounded by floating point. The widget copy follows, through the
  parity test.
- A signature that proves more: for example, record a hash of the signature and a timestamp on
  the server when the job-completed webhook fires, so a later replacement is detectable.

## Commits after approval
- `feat(widgets): add the signature pad and live line total widgets, and a demo page`: `widgets/`,
  `demo/`, `tests/widgets/`, `tests/demo.test.js`.
- `docs: widget install steps in the setup guide and README`.
- `docs: mark 05 plan done`.
