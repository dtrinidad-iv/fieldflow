import { describe, expect, it } from 'vitest';
import {
  buildInvoice, connectionId, formatMoney, invoiceNumber, localDate, MAX_LINE_ITEMS, parseMoneyCents, parseQuantityMilli,
} from '../../lib/invoice.js';

const business = { name: 'Acme Field Services', addressLines: ['1 Main St'], email: 'billing@acme.test', currency: 'USD', locale: 'en-US', timeZone: 'America/New_York' };
const base = {
  job: { id: 'job42', title: 'Fix boiler', scheduledDate: '2026-11-02' },
  customer: { name: 'Jane Customer', email: 'jane@example.test', address: { address: '12 Lane', city: 'Springfield', state: 'ST', zip: '00000' } },
  technician: { name: 'Sam Tech' },
  business,
  issuedAt: new Date('2026-11-03T15:00:00Z'),
};

describe('invoice', () => {
  it('builds lines and the total in integer cents', () => {
    const invoice = buildInvoice({
      ...base,
      items: [
        { description: 'Labour', quantity: 1.5, unitPrice: '$80.00' },
        { description: 'Valve', quantity: '2', unitPrice: 12.35 },
        { description: 'Tiny', quantity: 3, unitPrice: 0.1 },
      ],
    });
    expect(invoice.lines.map((l) => l.lineCents)).toEqual([12000, 2470, 30]);
    expect(invoice.totalCents).toBe(14500);
    expect(invoice).toMatchObject({
      number: 'INV-job42',
      issuedDate: '2026-11-03',
      jobTitle: 'Fix boiler',
      technician: 'Sam Tech',
      customer: { name: 'Jane Customer', address: ['12 Lane', 'Springfield ST 00000'] },
    });
  });

  it('computes line totals in integers, rounding half up (no float products)', () => {
    // 0.145 * 100 = 14.499999999999998 in floating point: must still round to 15 cents.
    const invoice = buildInvoice({ ...base, items: [{ quantity: '0.145', unitPrice: 1 }, { quantity: 1, unitPrice: 0.1 }, { quantity: 1, unitPrice: 0.2 }] });
    expect(invoice.lines.map((l) => l.lineCents)).toEqual([15, 10, 20]);
    expect(invoice.totalCents).toBe(45);
  });

  it('allows a job with no items to total zero', () => {
    expect(buildInvoice({ ...base, items: [] }).totalCents).toBe(0);
  });

  it.each([
    [{ quantity: -1, unitPrice: 5 }, /item 1 quantity is not a quantity/],
    [{ quantity: 'two', unitPrice: 5 }, /item 1 quantity is not a quantity/],
    [{ quantity: '', unitPrice: 5 }, /item 1 quantity is not a quantity/],
    [{ quantity: '1.2345', unitPrice: 5 }, /item 1 quantity is not a quantity with at most 3 decimals/],
    [{ quantity: 1 }, /item 1 unit price is not an amount/],
    [{ quantity: 1, unitPrice: 'free' }, /item 1 unit price is not an amount/],
    [{ quantity: 1, unitPrice: 12.345 }, /item 1 unit price is not an amount with at most 2 decimals/],
    [{ quantity: 1, unitPrice: -5 }, /item 1 unit price is negative/],
  ])('rejects a bad line item %j with 422', (item, message) => {
    expect(() => buildInvoice({ ...base, items: [item] })).toThrow(expect.objectContaining({ status: 422, message: expect.stringMatching(message) }));
  });

  it(`rejects more than ${MAX_LINE_ITEMS} line items`, () => {
    const items = Array.from({ length: MAX_LINE_ITEMS + 1 }, () => ({ quantity: 1, unitPrice: 1 }));
    expect(() => buildInvoice({ ...base, items })).toThrow(expect.objectContaining({ status: 422 }));
  });

  it.each([
    ['$1,234.50', 123450], ['1234.5', 123450], ['1,234', 123400], ['-$5.00', -500], [19.99, 1999], ['0', 0], [' 7.05 ', 705],
  ])('parses the amount %j', (value, cents) => {
    expect(parseMoneyCents(value, 'x')).toBe(cents);
  });

  it.each(['1.234,50', '($25.00)', '12.345', '1,23', '1,2345', '1.2.3', '$', '', '12.', 'abc', '€5', 12.345, Infinity])(
    'refuses to guess at the amount %j',
    (value) => {
      expect(() => parseMoneyCents(value, 'x')).toThrow(expect.objectContaining({ status: 422 }));
    },
  );

  it('parses quantities to thousandths', () => {
    expect(parseQuantityMilli('1.25', 'x')).toBe(1250);
    expect(parseQuantityMilli(3, 'x')).toBe(3000);
  });

  it('reads connection values in every shape the API may use', () => {
    expect(connectionId('c1')).toBe('c1');
    expect(connectionId(['c2'])).toBe('c2');
    expect(connectionId([{ id: 'c3', val: 'Jane' }])).toBe('c3');
    expect(connectionId({ id: 'c4' })).toBe('c4');
    expect(connectionId([])).toBeUndefined();
    expect(connectionId(null)).toBeUndefined();
  });

  it('formats money without narrow no-break spaces', () => {
    expect(formatMoney(123450)).toBe('$1,234.50');
    expect(formatMoney(123450, { currency: 'EUR', locale: 'fr-FR' })).toBe('1 234,50 €');
  });

  it('numbers invoices by job only, so a retry on another day gets the same number', () => {
    expect(invoiceNumber('job42')).toBe('INV-job42');
  });

  it('dates the invoice in the business time zone', () => {
    const lateNewYearsEve = new Date('2027-01-01T03:00:00Z'); // 22:00 on Dec 31 in New York
    expect(localDate(lateNewYearsEve, 'America/New_York')).toBe('2026-12-31');
    expect(localDate(lateNewYearsEve, 'UTC')).toBe('2027-01-01');
    expect(buildInvoice({ ...base, items: [], issuedAt: lateNewYearsEve }).issuedDate).toBe('2026-12-31');
  });
});
