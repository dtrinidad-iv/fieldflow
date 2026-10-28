// FieldFlow live line total. A plain script (no build step): paste it into the app's JavaScript
// settings, then mount it from a component callback (widgets/README.md).
//
// Shows Quantity x Unit Price while the user types in a Job Items form. Display only: the native
// Line Total formula stays the source of truth. The number rules are copied from lib/invoice.js
// (a plain script can't import), and tests/widgets/line-total.test.js checks that both agree, so
// an amount the invoice function would reject is flagged here first.
(function () {
  'use strict';

  const SLUG = /^[A-Za-z0-9_-]+$/;
  const instances = new WeakMap();

  // Integer cents from a US-formatted amount ("1234.50", "$1,234.50"), or null if it isn't one.
  function parseMoneyCents(value) {
    const text = String(value ?? '').trim();
    const negative = text.startsWith('-');
    const unsigned = (negative ? text.slice(1) : text).replace(/^\$/, '');
    const parts = unsigned.split('.');
    const whole = parts[0];
    const fraction = parts[1] ?? '';
    const groups = whole.split(',');
    const wholeOk =
      groups.length === 1 ? /^\d+$/.test(whole) : /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
    if (!wholeOk || parts.length > 2 || !/^\d{0,2}$/.test(fraction) || (unsigned.includes('.') && fraction === '')) return null;
    const cents = Number(groups.join('')) * 100 + Number(fraction.padEnd(2, '0'));
    return negative ? -cents : cents;
  }

  // Thousandths from a quantity with at most 3 decimals ("2", "1.25"), or null.
  function parseQuantityMilli(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$|^\d+\.\d{1,3}$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  }

  // Integer math, rounding half up, exactly as the invoice computes a line.
  const lineCents = (quantityMilli, unitCents) => Math.floor((quantityMilli * unitCents + 500) / 1000);

  // A second mount returns the same instance while it's still in place. After a re-render that
  // kept the element but replaced its inputs (or after an error that may be fixed now), the old
  // instance is torn down and the widget mounts again.
  function mount(target, options) {
    if (!(target instanceof Element)) return { destroy() {}, live: () => false };
    const existing = instances.get(target);
    if (existing) {
      if (existing.live()) return existing;
      existing.destroy();
    }

    const opts = Object.assign({ currency: 'USD', locale: 'en-US' }, options);
    const box = document.createElement('div');
    box.className = 'ff-total';
    const output = document.createElement('p');
    output.className = 'ff-total-output';
    output.setAttribute('role', 'status');
    output.setAttribute('aria-live', 'polite');
    box.append(output);

    const show = (text, kind) => {
      output.textContent = text;
      box.classList.toggle('ff-total-hint', kind === 'hint');
      box.classList.toggle('ff-total-error', kind === 'error');
      box.classList.toggle('ff-total-empty', text === '');
    };
    const find = (slug) => (typeof slug === 'string' && SLUG.test(slug) ? target.querySelector('[name="' + slug + '"]') : null);
    const quantity = find(opts.quantityField);
    const unitPrice = find(opts.unitPriceField);
    const listeners = new AbortController();
    const instance = {
      // An error instance (missing field) is never live, so the next mount tries again.
      live: () => Boolean(quantity && unitPrice) && target.contains(box) && target.contains(quantity) && target.contains(unitPrice),
      destroy() {
        listeners.abort();
        box.remove();
        if (instances.get(target) === instance) instances.delete(target);
        target.removeAttribute('data-fieldflow-line-total');
      },
    };
    instances.set(target, instance);
    target.setAttribute('data-fieldflow-line-total', '');
    let format;
    try {
      format = new Intl.NumberFormat(opts.locale, { style: 'currency', currency: opts.currency });
    } catch {
      format = null;
    }

    if (!quantity || !unitPrice || !format) {
      target.append(box);
      show(
        format ? 'Line total: the Quantity or Unit Price field was not found on this form.' : 'Line total: invalid currency or locale setting.',
        'error',
      );
      return instance;
    }

    function update() {
      const q = quantity.value.trim();
      const p = unitPrice.value.trim();
      if (q === '' || p === '') return show('', null);
      const milli = parseQuantityMilli(q);
      if (milli === null) return show('Use a quantity like 2 or 1.25 (up to 3 decimals).', 'hint');
      const cents = parseMoneyCents(p);
      if (cents === null || cents < 0) return show('Use an amount like 1234.50 (no comma decimals, up to 2 decimals).', 'hint');
      return show('Line total: ' + format.format(lineCents(milli, cents) / 100), null);
    }

    for (const input of [quantity, unitPrice]) {
      input.addEventListener('input', update, { signal: listeners.signal });
      input.addEventListener('change', update, { signal: listeners.signal });
    }
    unitPrice.after(box);
    update();
    return instance;
  }

  const root = (window.FieldFlow = window.FieldFlow || {});
  root.lineTotal = { mount, parseMoneyCents, parseQuantityMilli, lineCents };
})();
