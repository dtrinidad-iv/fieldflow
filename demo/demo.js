// Mounts the widgets on the demo page the way the TB.render snippets in widgets/README.md do in
// the app. "Save" is simulated: the signature is copied to the details section, as Tadabase would
// show it after saving.
(function () {
  'use strict';

  const FieldFlow = window.FieldFlow;
  let view;

  function mountAll() {
    FieldFlow.signaturePad.mount(document.getElementById('complete-job'), { signatureField: 'field_906' });
    FieldFlow.lineTotal.mount(document.getElementById('job-item'), { quantityField: 'field_902', unitPriceField: 'field_903' });
    view = FieldFlow.signaturePad.mount(document.getElementById('signature-value'), { mode: 'view' });
  }

  function start() {
    const signature = document.getElementById('signature');
    const preview = document.getElementById('signature-preview');
    const value = document.getElementById('signature-value');

    signature.addEventListener('input', () => {
      const v = signature.value;
      preview.textContent = v ? v.length.toLocaleString() + ' characters, starts ' + v.slice(0, 30) + '...' : '(empty)';
    });

    document.getElementById('complete-job-form').addEventListener('submit', (event) => {
      event.preventDefault();
      value.textContent = signature.value;
      view.destroy(); // the details page re-renders after a save
      view = FieldFlow.signaturePad.mount(value, { mode: 'view' });
    });
    document.getElementById('job-item-form').addEventListener('submit', (event) => event.preventDefault());
    document.getElementById('rerender').addEventListener('click', mountAll);

    mountAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
