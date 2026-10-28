// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildInvoice, parseMoneyCents as libMoney, parseQuantityMilli as libQuantity } from '../../lib/invoice.js';

let total;

beforeAll(async () => {
  await import('../../widgets/line-total.js');
  total = window.FieldFlow.lineTotal;
});

beforeEach(() => document.body.replaceChildren());

function form(quantity = '', unitPrice = '') {
  const section = document.createElement('section');
  for (const [name, value] of [['field_902', quantity], ['field_903', unitPrice]]) {
    const input = document.createElement('input');
    input.name = name;
    input.value = value;
    section.append(input);
  }
  document.body.append(section);
  return section;
}

const opts = { quantityField: 'field_902', unitPriceField: 'field_903' };
const output = (root) => root.querySelector('.ff-total-output');

function type(section, name, value) {
  const input = section.querySelector(`[name="${name}"]`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('line total widget', () => {
  it('shows the total for the initial values and updates while typing', () => {
    const section = form('2.5', '$1,234.50');
    total.mount(section, opts);
    expect(output(section).textContent).toBe('Line total: $3,086.25');
    type(section, 'field_902', '3');
    expect(output(section).textContent).toBe('Line total: $3,703.50');
  });

  it('shows nothing while a field is empty', () => {
    const section = form('2', '');
    total.mount(section, opts);
    expect(output(section).textContent).toBe('');
    expect(section.querySelector('.ff-total').classList.contains('ff-total-empty')).toBe(true);
  });

  it.each([
    ['1.234,50', /amount like 1234.50/],
    ['12.345', /amount like 1234.50/],
    ['-5', /amount like 1234.50/],
  ])('flags the price %s the invoice would reject', (price, hint) => {
    const section = form('1', price);
    total.mount(section, opts);
    expect(output(section).textContent).toMatch(hint);
    expect(section.querySelector('.ff-total').classList.contains('ff-total-hint')).toBe(true);
  });

  it('flags a quantity with more than 3 decimals', () => {
    const section = form('1.2345', '10');
    total.mount(section, opts);
    expect(output(section).textContent).toMatch(/quantity like 2 or 1.25/);
  });

  it.each([
    ['0.333', '0.01', '$0.00'],
    ['0.5', '0.01', '$0.01'], // half up
    ['1.5', '0.03', '$0.05'],
    ['2.125', '4.00', '$8.50'],
    ['1000', '$1,000.00', '$1,000,000.00'],
  ])('%s x %s = %s, in integer math', (quantity, price, expected) => {
    const section = form(quantity, price);
    total.mount(section, opts);
    expect(output(section).textContent).toBe(`Line total: ${expected}`);
  });

  it('uses the currency and locale options', () => {
    const section = form('2', '10');
    total.mount(section, { ...opts, currency: 'EUR', locale: 'de-DE' });
    expect(output(section).textContent).toMatch(/^Line total: 20,00\s€$/);
  });

  it('shows an error for an invalid currency setting', () => {
    const section = form('2', '10');
    total.mount(section, { ...opts, currency: 'not a currency' });
    expect(output(section).textContent).toMatch(/invalid currency/);
  });

  it('shows a visible error when a field is missing or a slug is invalid', () => {
    const section = form('2', '10');
    total.mount(section, { quantityField: 'field_902', unitPriceField: 'field_999' });
    expect(output(section).textContent).toMatch(/not found/);
    expect(section.querySelector('.ff-total').classList.contains('ff-total-error')).toBe(true);

    const other = form('2', '10');
    total.mount(other, { quantityField: '"],[x', unitPriceField: 'field_903' });
    expect(output(other).textContent).toMatch(/not found/);
  });

  it('does nothing, without throwing, when the target element is missing', () => {
    expect(() => total.mount(null, opts).destroy()).not.toThrow();
  });

  it('is safe to mount twice: one output, still updating', () => {
    const section = form('1', '10');
    const first = total.mount(section, opts);
    expect(total.mount(section, opts)).toBe(first);
    expect(section.querySelectorAll('.ff-total')).toHaveLength(1);
    type(section, 'field_902', '2');
    expect(output(section).textContent).toBe('Line total: $20.00');
  });

  it('destroy removes the output and its listeners', () => {
    const section = form('1', '10');
    const instance = total.mount(section, opts);
    const out = output(section);
    instance.destroy();
    expect(section.querySelector('.ff-total')).toBeNull();
    type(section, 'field_902', '5');
    expect(out.textContent).toBe('Line total: $10.00');
    expect(total.mount(section, opts)).not.toBe(instance);
  });

  it('updates on change as well as input (autofill, pickers)', () => {
    const section = form('1', '10');
    total.mount(section, opts);
    const quantity = section.querySelector('[name="field_902"]');
    quantity.value = '4';
    quantity.dispatchEvent(new Event('change', { bubbles: true }));
    expect(output(section).textContent).toBe('Line total: $40.00');
  });

  it('mounts again when a re-render replaced the inputs inside the same element', () => {
    const section = form('1', '10');
    const first = total.mount(section, opts);
    const fresh = form('3', '10');
    section.replaceChildren(...fresh.children);
    const second = total.mount(section, opts);
    expect(second).not.toBe(first);
    expect(section.querySelectorAll('.ff-total')).toHaveLength(1);
    type(section, 'field_902', '5');
    expect(output(section).textContent).toBe('Line total: $50.00');
  });

  it('recovers from "field not found" once the fields appear', () => {
    const section = document.createElement('section');
    document.body.append(section);
    total.mount(section, opts);
    expect(output(section).textContent).toMatch(/not found/);
    section.replaceChildren(...form('2', '10').children);
    total.mount(section, opts);
    expect(section.querySelectorAll('.ff-total')).toHaveLength(1);
    expect(output(section).textContent).toBe('Line total: $20.00');
  });

  it('renders field text as text, never as HTML', () => {
    const section = form('<img src=x onerror=alert(1)>', '10');
    total.mount(section, opts);
    expect(section.querySelector('img')).toBeNull();
  });
});

// The widget copies lib/invoice.js's rules (a plain script can't import it). If either changes
// alone, these fail.
describe('parity with lib/invoice.js', () => {
  const lib = (fn, value) => {
    try {
      return fn(value, 'x');
    } catch {
      return null;
    }
  };

  it.each([
    '0', '1', '7', ' 7.25 ', '1234.50', '1234.5', '$1,234.50', '$0.99', '1,234', '1,000,000.99', '00012.30',
    '-5', '-$5', '$-5', '+5', '', ' ', '$', '.5', '1.', '1.234', '1.234,50', '12,34', '1,0000', '1,23,456',
    '5.5.5', '1e3', '0x10', 'NaN', 'Infinity', '12 34', 'abc', '١٢',
  ])('money %j', (input) => {
    expect(total.parseMoneyCents(input)).toBe(lib(libMoney, input));
  });

  it.each([
    '0', '2', ' 3 ', '1.25', '0.333', '10.000', '1.2345', '-1', '1,000', '.5', '1.', '', '1e2', 'abc', '+2',
  ])('quantity %j', (input) => {
    expect(total.parseQuantityMilli(input)).toBe(lib(libQuantity, input));
  });

  it.each([
    ['0.333', '0.01'], ['0.5', '0.01'], ['1.5', '0.03'], ['2.125', '4.00'], ['2.5', '1234.50'],
    ['0.001', '0.50'], ['0.001', '0.49'], ['7', '$0.07'], ['999.999', '$9,999.99'], ['1', '0'],
  ])('line total %s x %s matches the invoice', (quantity, unitPrice) => {
    const invoice = buildInvoice({
      job: { id: 'job1' },
      customer: { name: 'C' },
      items: [{ quantity, unitPrice }],
      business: { timeZone: 'UTC' },
      issuedAt: new Date(0),
    });
    const widget = total.lineCents(total.parseQuantityMilli(quantity), total.parseMoneyCents(unitPrice));
    expect(widget).toBe(invoice.lines[0].lineCents);
  });
});
