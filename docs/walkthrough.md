# Walkthrough

A 15-minute tour of FieldFlow end to end, on the **dev** app once [go-live](go-live.md) phases A–F
are done. It shows each piece in the order a real job goes through them, and says which part is
native Tadabase and which is FieldFlow code. Use test data: on prod, delete the test records
afterwards.

## 1. Set up a customer and technicians (native)
1. Add a customer, **Test Customer**, with an email and address.
2. Add two technicians, **Alex** and **Sam**.

## 2. Schedule jobs, and try to double-book (native rule + `check-schedule`)
1. Create a job: *Replace water heater*, customer Test Customer, technician Alex, tomorrow,
   slot **Morning**. It appears in **Scheduled** on the board (Status defaults to Scheduled,
   go-live C.2).
2. Create a second job for Alex, tomorrow, **Morning**. **The form refuses to save:** "This
   technician is already booked for that slot." (a native validation rule).
3. Save it as **Afternoon** instead. Then, in the office Jobs table with inline editing on Slot
   (go-live F.4), change its slot to **Morning**, which skips the form. (Board cards aren't
   editable, and a drag only changes Status, so the board can't double-book.) Within seconds **both jobs show Schedule Conflict**
   ("Double-booked with: ..."). That's `check-schedule`, catching what the form can't see.
4. Move the second job back to **Afternoon**: both flags clear.

## 3. Work the job on the board (native Kanban)
1. Drag *Replace water heater* from **Scheduled** to **In Progress**, and reload: it stays.
2. Try to drag it into **Completed**: not possible. Completing goes through the form, which takes
   the customer's signature.

## 4. Add line items (live total widget)
1. Open the job, and add an item: *Labour*, quantity `2.5`, unit price `$80.00`. **While you
   type**, it shows "Line total: $200.00". After saving, the native Line Total agrees.
2. Add another item, *Valve*, quantity `1`, and type `1.234,50` as the price: **a hint appears**
   ("Use an amount like 1234.50"), the same rule the invoice uses. Correct it to `45.00` and save.
3. The job's Total (a native rollup) is now $245.00.

## 5. Complete the job (signature widget + invoice function)
1. Open **Complete job** and press Save without signing: **"required"**.
2. Sign with the mouse or a finger. **Clear** works; sign again, then Save.
3. Within a few seconds:
   - an **Invoices** record appears: number `INV-<job id>`, amount $245.00, issued today
   - the job moves to **Invoiced** (the native record rule)
   - the details page shows the signature as an image
4. Open the invoice's **PDF link**: the invoice, with your business details, the customer, the job,
   both line items and the total.
5. Change one character of the link's `sig=` and open it: **403**. The PDF is private and only
   opens with the exact signed link.

## 6. A job that isn't ready (send-back)
1. Create a third job (Sam, any free slot) with **no line items**. Sign it and complete it.
2. Within seconds it's **back in In Progress**, and **Invoice Problem** says "Not invoiced: job
   has no line items. Fix it and complete the job again." No invoice was made.
3. Add an item and complete it again: invoiced, and Invoice Problem clears.

## What was native, and what was code
| Step | Native Tadabase | FieldFlow code |
|---|---|---|
| Records, forms, totals, the Kanban board, status rules | ✓ | |
| Double-booking blocked on the form | ✓ (validation rule) | |
| Double-booking flagged after a drag or inline edit | | `check-schedule` |
| Live line total, and the bad-price hint | | line total widget |
| Signature capture and display | | signature pad widget |
| PDF invoice, private storage, signed link | | `generate-invoice`, `invoice-pdf` |
| Unready jobs sent back with the reason | | `generate-invoice` |
