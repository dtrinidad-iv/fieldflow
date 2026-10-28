# Widgets

Small browser scripts that add what Tadabase's native components can't do. Each is a plain,
self-contained file with no build step and no dependencies. Widgets never call an API and hold no
secrets: they only work with the form or page they're mounted in.

| Widget | Files | Where |
|---|---|---|
| Signature pad | `signature-pad.js`, `signature-pad.css` | The job's **Complete job** form (edit), and the job details page (view) |
| Live line total | `line-total.js`, `line-total.css` | The **Job Items** form |

Try them locally first: open `demo/index.html` in a browser (no server needed).

## Install
1. **Code:** paste each `.js` file into the app's custom JavaScript settings, and each `.css` file
   into its custom CSS settings. When a widget changes in this repo, paste it again.
2. **Find the ids:**
   - **Component id:** in the page builder, select the form or details component; its id looks
     like `component_12`.
   - **Field slug:** `field_NN`, from `config/tadabase.<stage>.json` (logical names
     `jobs.signature`, `jobItems.quantity`, `jobItems.unitPrice`) or from
     `scripts/tadabase-check.js`. Dev and prod have different slugs.
3. **Mount:** add the snippets below to that page's JavaScript, with your ids.

`TB.render` runs a callback each time Tadabase renders a component. Widgets are safe to mount
twice, so a re-render never adds a second pad or duplicate listeners.

### Signature pad (Complete job form)
```js
TB.render('component_12', function (data) {
  FieldFlow.signaturePad.mount(data.ele[0], { signatureField: 'field_45' });
});
```
Options: `signatureField` (required), `height` (px, default 200), `maxBytes` (default 100000).

The pad hides the form's Signature input and draws next to it. After each stroke the signature
goes into that input as a PNG data URL, and the form's own **Save** button stores it. **Clear**
empties it.

### Signature view (job details page)
Pass the element that displays the Signature value (it shows a long `data:image/png;base64,...`
text). The widget hides that text and shows the image instead. Anything that isn't a PNG data URL
shows "No signature".
```js
TB.render('component_14', function (data) {
  var value = data.ele[0].querySelector('.field_45'); // the Signature value element; check its selector in the browser
  FieldFlow.signaturePad.mount(value, { mode: 'view' });
});
```

### Live line total (Job Items form)
```js
TB.render('component_20', function (data) {
  FieldFlow.lineTotal.mount(data.ele[0], { quantityField: 'field_61', unitPriceField: 'field_62' });
});
```
Options: `quantityField` and `unitPriceField` (required), `currency` (default `USD`) and `locale`
(default `en-US`). Match them to `config/invoice.json`.

The total appears under Unit Price while you type. A value the invoice would reject, such as
`1.234,50` or `12.345`, shows a hint instead. The native Line Total is still what gets saved.

## Things to confirm on the dev app
These come from the Tadabase docs and haven't been checked on a live app yet:
1. `TB.render('component_NN', fn)` fires for the component, and `data.ele[0]` is its element.
2. Form inputs carry `name="field_NN"`. If they don't, the widget shows "field was not found"; send
   the input's real attributes (right-click → Inspect) so the lookup can be fixed.
3. A value set by the widget is saved when you press Save, and a 100 KB Long Text value comes back
   intact (the details page shows the signature image).
4. With Signature required, an unsigned Save shows a visible "required" message.
5. Quantity and Unit Price are text inputs, not `type="number"`. A number input hides what was
   typed from scripts until it's a valid number, so `1.234,50` would show nothing instead of a hint.

Who can edit the Signature field decides how much the signature proves: see
`docs/tadabase-setup.md` section 8, step 2.
