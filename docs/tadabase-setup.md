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
| Color | `color` | Text (a hex color, used by the kanban board) |

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
  a page per technician. The widgets in plans 05 and 06 attach to these pages.

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
- `422` when the job has no customer, no line items, an amount it can't read, or a Total that
  differs from its line items. Fix the job and save it again.
- `503` or `5xx` when it ran out of time or the app didn't answer: nothing is lost, and a retry (or
  saving the job again) finishes it, never creating a second invoice.

## What stays custom
| Need | Why the platform can't do it natively | Plan |
|---|---|---|
| PDF invoice generated and stored | No server-side PDF rendering or file storage API | 04 |
| Signature capture, live total while typing | Native forms have no drawing pad, and totals update only on save | 05 |
| Drag-and-drop kanban by status | No native kanban view with drag-to-update | 06 |
| Sync contacts to a CRM, validate jobs | Needs custom logic and calls to another API | 07 |
