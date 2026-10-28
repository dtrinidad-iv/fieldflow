# Tadabase setup

How to build the FieldFlow app in Tadabase and connect it to the AWS side. Everything here is done
in the Tadabase builder or in your own terminal; nothing in this repo writes to your app.

**Build natively first.** Tadabase stores the data, computes the totals, runs the status rules
and sends the webhooks. The AWS functions only do what the platform can't (see "What stays
custom" at the end).

## 1. Plan and apps
- Outgoing webhooks need the **Pro plan or higher**.
- You need **two apps**: `FieldFlow` (prod) and `FieldFlow Dev`. Build the prod app first (steps 2
  and 3), then duplicate it for dev. Each stage of the AWS stack talks only to its own app, so dev
  can be tested end to end, writes included, without touching real data.

## 2. Tables and fields
Create these five tables. The **Logical name** column is what `config/tadabase.<stage>.json` and the
code use. The **Type** column is the Tadabase field type to pick.

### Customers
| Field | Logical name | Type |
|---|---|---|
| Name | `name` | Text |
| Email | `email` | Email |
| Phone | `phone` | Phone |
| Address | `address` | Address |

### Technicians
| Field | Logical name | Type |
|---|---|---|
| Name | `name` | Text |
| Email | `email` | Email |

### Jobs
| Field | Logical name | Type |
|---|---|---|
| Title | `title` | Text |
| Description | `description` | Long Text |
| Scheduled Date | `scheduledDate` | Date |
| Customer | `customer` | Connection → Customers (many jobs to one customer) |
| Technician | `technician` | Connection → Technicians (many jobs to one technician) |
| Status | `status` | Drop Down: `Scheduled`, `In Progress`, `Completed`, `Invoiced` |
| Signature | `signature` | Long Text (holds the signature image as a data URL) |
| Total | `total` | Equation / Rollup: sum of its Job Items' Line Total |

### Job Items
| Field | Logical name | Type |
|---|---|---|
| Job | `job` | Connection → Jobs (many items to one job) |
| Description | `description` | Text |
| Quantity | `quantity` | Number |
| Unit Price | `unitPrice` | Currency |
| Line Total | `lineTotal` | Equation: `Quantity * Unit Price` |

### Invoices
| Field | Logical name | Type |
|---|---|---|
| Job | `job` | Connection → Jobs |
| Number | `number` | Text (filled in by the invoice function: `INV-<job id>`) |
| Issued Date | `issuedDate` | Date |
| Amount | `amount` | Currency |
| PDF | `pdfLink` | Link |

You can add more fields; the code ignores anything it doesn't map.

## 3. Native rules and pages
- **Totals** are formula fields (above), not code: Line Total and Job Total update on save.
- **Status changes** use native record rules where they can: for example, set Status to
  `Invoiced` when an Invoices record is connected.
- **Pages:** a Jobs table with a details page, a form for Job Items inside the job details, and
  a page per technician. The plan 05 widgets attach to these pages, and the plan 06 Kanban board
  is a native component on them.

## 4. API key
1. In the builder: **Settings → API Keys → Add API key**. Create **two keys in each app**:
   - **`fieldflow-aws`**: read and write access to the five tables above, nothing else. It goes only
     into SSM (below), never onto your laptop.
   - **`fieldflow-check`**: **read-only** access to the same five tables. It's for the local check
     script, so a leaked `.env` can't change your data.
2. Each key has three values: **App ID**, **App Key** and **App Secret**.
3. For the check (step 5), put the dev app's **`fieldflow-check`** values in your local `.env`
   (copied from `.env.example`): `TADABASE_APP_ID`, `TADABASE_APP_KEY`, `TADABASE_APP_SECRET`.
   Never commit `.env`.
4. For AWS, store the **`fieldflow-aws`** values, plus a webhook secret, as SecureString parameters.
   Run this yourself, once per stage (`dev` and `prod`), with each app's own values. Claude can't
   run AWS writes.

   ```bash
   export AWS_REGION=us-east-1   # the stack's region (samconfig.toml); parameters elsewhere aren't found
   STAGE=dev                     # then repeat with STAGE=prod and the prod app's values

   # Each value is typed (or pasted) without echo, so it never lands in your shell history.
   for NAME in app-id app-key app-secret; do
     printf 'Tadabase %s: ' "$NAME"; read -rs VALUE; echo
     aws ssm put-parameter --type SecureString --name "/fieldflow/$STAGE/tadabase/$NAME" --value "$VALUE"
   done
   unset VALUE
   aws ssm put-parameter --type SecureString --name "/fieldflow/$STAGE/webhook-secret" --value "$(openssl rand -hex 32)"
   aws ssm put-parameter --type SecureString --name "/fieldflow/$STAGE/link-secret"    --value "$(openssl rand -hex 32)"
   ```

   Don't add `--key-id`: the default `aws/ssm` key needs no extra permission, while a
   customer-managed key would also need a `kms:Decrypt` grant on every function.

   Add `--overwrite` to rotate a value; running functions pick it up within 5 minutes. To see the
   webhook secret once, for step 6 (don't paste it anywhere but the webhook's header):
   `aws ssm get-parameter --with-decryption --query Parameter.Value --output text --name "/fieldflow/$STAGE/webhook-secret"`.

## 5. Field slugs: fill in the mapping
Tadabase names fields `field_NN` in the API. The code maps them in `config/tadabase.dev.json` and
`config/tadabase.prod.json`. To fill them in, run the read-only check from the repo root:

```bash
nvm use                                            # Node 24, from .nvmrc
node --env-file=.env scripts/tadabase-check.js dev
```

1. While the file still says `"placeholder": true`, the script lists every table (with its id) and
   every field (slug, type, name). Copy the ids and slugs into `config/tadabase.dev.json` and set
   `"placeholder": false`.
2. Run it again. Now it checks the mapping: every line should be `OK`. `CHECK` means a field's type
   looks different from the table above (fix the field, or confirm it's fine). `FAIL` means a table
   or slug is wrong. It also prints what the API answers for a missing record and a missing table.
3. Repeat for prod with the prod app's keys in `.env` and `prod` as the argument.

The script only reads (a test makes sure every request is a GET) and prints ids, field names and
types, never record values or keys. Deployed functions refuse to start while a mapping still holds
placeholders.

## 6. Outgoing webhooks (the pattern)
Each later plan adds its own webhook; they all follow this pattern. In the builder:
**Automation → Outgoing Webhooks → Add**.

- **Table and trigger:** the table, and On record create / update / delete, plus a field filter if
  the plan says so (for example: Jobs, on update, when Status is `Completed`).
- **Method and URL:** `POST` to the function's URL, from the stack outputs after a deploy (plan 08).
- **Headers:** `X-FieldFlow-Secret: <the webhook-secret value for this stage>`. Functions reject any
  request without it (401).
- **Body:** a custom JSON template with the record id and the fields the plan lists, for example
  `{"recordId": "{record_id}", "status": "{field_NN}"}`.

## 7. Invoices (plan 04)
When a job is marked **Completed**, a function renders its PDF invoice, stores it privately in
AWS, and creates the Invoices record with the amount and a link to the PDF. It runs once per job,
however often the webhook is delivered.

1. **Business details:** fill in `config/invoice.json` (name, address lines, email, currency,
   locale, and `timeZone`, which dates the invoice) and set `"placeholder": false`. The function
   refuses to invoice until you do. Prices must be plain amounts like `1234.50` (US format, at most
   2 decimals); anything else is refused rather than guessed.
2. **Record rule:** on Invoices, when a record is created, set its connected Job's Status to
   `Invoiced`.
3. **Outgoing webhook** (after the deploy, plan 08):
   - Table: Jobs. Trigger: On record update. Filter: Status is `Completed`.
   - `POST` to the `JobCompletedWebhookUrl` stack output.
   - Header `X-FieldFlow-Secret: <webhook-secret>`.
   - Body: `{"recordId": "{record_id}"}`.
4. **Links:** the PDF link in each invoice is signed with `link-secret`. Anyone with the link can
   open that one PDF; rotating `link-secret` makes every existing link stop working.

The function answers:
- `201` when it created the invoice
- `200` when the invoice already exists, or the job isn't Completed (nothing happens)
- `409` when another delivery for the same job is still running
- `422` when the job has no customer signature (section 8), no customer, no line items, an amount
  it can't read, or a Total that differs from its line items. Fix the job and save it again.
- `503` or `5xx` when it ran out of time or the app didn't answer: nothing is lost, and a retry (or
  saving the job again) finishes it, never creating a second invoice.

## 8. Widgets (plan 05)
Two small scripts add what native forms can't: a **signature pad** on the job's completion form,
and a **live line total** on the Job Items form. They hold no keys and call no API: the signature
is saved by the form's own Save button, and the total is display only. Try them first in
`demo/index.html` (open it in a browser).

1. **Complete job form:** on the job details page, add a form that edits the job, with
   **Signature** (Long Text). Don't show Status as a free dropdown, which would also offer
   `Invoiced`: have the form set Status to `Completed` on submit (a form rule, or a fixed value).
   Make Signature **required** on this form. The invoice function also refuses a job without a
   signature (422, nothing created), however its Status became Completed, so an unsigned job is
   never invoiced. Once it's signed and saved, it's invoiced as usual.
2. **Lock the signature down.** The signature is only as trustworthy as who can edit the field.
   Anyone who can edit Signature can paste in another image, for example one copied from another
   job. So, natively:
   - Signature is editable only on the Complete job form, and only for the roles that complete jobs.
   - Every other form, inline edit in tables, and imports leave Signature out, or show it read-only.
   - Keep record history on for Jobs, so a replaced signature can be traced.
3. **Paste the code:** `widgets/signature-pad.js` and `widgets/line-total.js` into the app's custom
   JavaScript, and `widgets/signature-pad.css` and `widgets/line-total.css` into its custom CSS.
   Paste them again whenever they change in the repo.
4. **Mount them:** add the snippets from [`widgets/README.md`](../widgets/README.md) to each page's
   JavaScript, with that page's component ids and this app's field slugs (`jobs.signature`,
   `jobItems.quantity`, `jobItems.unitPrice` in `config/tadabase.<stage>.json`).
5. **Check on the dev app** (these couldn't be confirmed from the docs alone):
   1. The pad and the total appear. If a widget says a field "was not found", inspect the input
      (right-click → Inspect) and note its attributes: the widget looks for `name="field_NN"`.
   2. Sign a test job and press Save. The job details page shows the signature as an image, which
      proves the value was saved and came back intact.
   3. Press Save without signing. You should see a visible "required"
      message, not a Save button that silently does nothing.
   4. Add a job item. The total updates while you type, and matches the native Line Total after
      saving. Type `1.234,50` as the price: a hint appears. If nothing appears, the inputs are
      `type="number"` (the browser hides what was typed), and the hint can only cover text inputs.

## 9. Kanban board (plan 06)
The board is **native**: Tadabase's Kanban component shows jobs as cards in columns by Status, and
dragging a card to another column updates the job's Status, under the board's permissions and with
record rules applied. No code is involved.

1. **The office board:** on an office page, add a **Kanban** component:
   - Table **Jobs**, grouped by **Status**.
   - Columns in this order: `Scheduled`, `In Progress`, `Completed`, `Invoiced`.
   - Card fields: Title, Customer, Scheduled Date, Technician, and nothing editable on the card.
     Never put Signature on a card.
2. **Guard rails.** Two statuses must not be set, or undone, by dragging:
   - **Completed** invoices the job (the job-completed webhook, section 7) and should go through
     the Complete job form, which takes the customer's signature (section 8).
   - **Invoiced** is set by the record rule when an invoice is created. Set by hand, it marks a job
     invoiced with no invoice.

   So, in the builder, use the first option that's available:
   1. Lock **Completed** and **Invoiced** both ways: cards can't be dropped into them, and cards
      in them can't be dragged out. They're still shown.
   2. Otherwise (including if only drops *into* a column can be blocked), show only **Scheduled**
      and **In Progress** on the board. Under it, add a native table of Jobs filtered to Status is
      Completed or Invoiced, **read-only**: no inline edit, no edit action, only a link to the
      details page.

   Why both ways: a job pulled back out of Completed or Invoiced and completed again **never gets
   a second invoice, but its invoice isn't updated either, and the job doesn't return to
   Invoiced** (the record rule only fires when an invoice is created). The PDF and Amount keep the
   old total. Invoices aren't corrected through the board: a correction is a manual office task
   (void and re-issue isn't built).
3. **Permissions:** only the office and technician roles can drag cards. Any other role (for
   example customers) doesn't see the board.
4. **Technician board (recommended):** on the technician page, the same component filtered to jobs
   whose Technician is the logged-in user, and keep the office board to the office role. That
   needs a connection from Technicians to Users (native; the code doesn't use it). Without it,
   every technician sees, and can move, every job on the office board.
5. **Optional, for phones** (where dragging is awkward): a native action link on each card, such
   as **Start** (sets Status to `In Progress`). Don't add a "Complete" action: completing goes
   through the form.
6. **Check on the dev app:**
   1. Drag a card from Scheduled to In Progress, then reload the page: it stays moved.
   2. A card can't be dropped into Completed or Invoiced, and a card in them can't be dragged
      back out (option 1); or those columns aren't on the board (option 2).
   3. Signed in as a role without permission, cards can't be dragged.
   4. No form or table lets anyone set Status to `Invoiced` by hand.

## What stays custom
| Need | Why the platform can't do it natively | Plan |
|---|---|---|
| PDF invoice generated and stored | No server-side PDF rendering or file storage API | 04 |
| Signature capture, live total while typing | Native forms have no drawing pad, and totals update only on save | 05 |
| Sync contacts to a CRM, validate jobs | Needs custom logic and calls to another API | 07 |
