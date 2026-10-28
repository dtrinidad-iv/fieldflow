import { PDFDocument } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildInvoice } from '../../lib/invoice.js';
import { MAX_TEXT, renderInvoicePdf } from '../../lib/pdf.js';

const business = { name: 'Acme Field Services', addressLines: ['1 Main St', 'Springfield'], email: 'billing@acme.test', currency: 'USD', locale: 'en-US' };
const make = (items, overrides = {}) =>
  buildInvoice({
    job: { id: 'job42', title: 'Fix boiler', scheduledDate: '2026-11-02' },
    customer: { name: 'Jane Customer', email: 'jane@example.test', address: '12 Lane, Springfield' },
    technician: { name: 'Sam Tech' },
    business,
    issuedAt: new Date('2026-11-03T15:00:00Z'),
    items,
    ...overrides,
  });

// pdf-lib writes standard-font text as hex strings, inside content streams that may be compressed.
async function pageText(bytes) {
  const doc = await PDFDocument.load(bytes);
  const hex = (s) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
  const streams = doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const refs = contents.asArray ? contents.asArray() : [contents];
    return refs
      .map((ref) => {
        const stream = doc.context.lookup(ref);
        const raw = Buffer.from(stream.getContents());
        try {
          return inflateSync(raw).toString('latin1');
        } catch {
          return raw.toString('latin1');
        }
      })
      .join('\n');
  });
  return {
    doc,
    has: (page, s) => streams[page].toUpperCase().includes(hex(s)),
    // one whole text item, e.g. <50617274203130> for 'Part 10'
    exact: (page, s) => streams[page].toUpperCase().includes(`<${hex(s)}>`),
  };
}

describe('renderInvoicePdf', () => {
  it('renders a one-page PDF with the invoice details', async () => {
    const bytes = await renderInvoicePdf(make([{ description: 'Labour', quantity: 2, unitPrice: 80 }]));
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const { doc, has } = await pageText(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe('Invoice INV-job42');
    for (const s of ['Acme Field Services', 'INV-job42', 'Jane Customer', 'Labour', '$160.00', 'Total']) expect(has(0, s), s).toBe(true);
  });

  it('continues a long item list on further pages', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ description: `Part ${i + 1}`, quantity: 1, unitPrice: 1 }));
    const { doc, has, exact } = await pageText(await renderInvoicePdf(make(items)));
    const last = doc.getPageCount() - 1;
    expect(last).toBeGreaterThanOrEqual(1);
    expect(has(0, 'Part 1')).toBe(true);
    expect(has(last, 'Part 60')).toBe(true);
    expect(has(last, 'Description')).toBe(true); // the table header repeats
    expect(has(last, '$60.00')).toBe(true);
    // every row is drawn exactly once across the pages: none dropped, none repeated
    const pages = [...Array(doc.getPageCount()).keys()];
    for (let i = 1; i <= 60; i += 1) {
      expect(pages.filter((pg) => exact(pg, `Part ${i}`)), `Part ${i}`).toHaveLength(1);
    }
  });

  it('replaces characters the standard fonts cannot draw instead of crashing', async () => {
    const invoice = make([{ description: 'Boiler 修理 🔧', quantity: 1, unitPrice: 10 }], {
      customer: { name: 'Zoë Ångström', address: [] },
    });
    const { has } = await pageText(await renderInvoicePdf(invoice));
    expect(has(0, 'Boiler ?? ?')).toBe(true);
    expect(has(0, 'Zoë Ångström')).toBe(true); // Latin-1 accents are drawable
  });

  it('cuts huge fields before measuring them, so rendering stays fast', async () => {
    const huge = 'y'.repeat(200_000);
    const started = Date.now();
    const bytes = await renderInvoicePdf(make([{ description: huge, quantity: 1, unitPrice: 1 }], {
      customer: { name: huge, email: huge, address: [huge] },
    }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await pageText(bytes)).has(0, 'y'.repeat(MAX_TEXT + 1))).toBe(false);
  });

  it('shortens text that would overflow its column', async () => {
    const long = 'x'.repeat(300);
    const { has } = await pageText(await renderInvoicePdf(make([{ description: long, quantity: 1, unitPrice: 1 }])));
    expect(has(0, long)).toBe(false);
    expect(has(0, 'xxx...')).toBe(true);
  });
});
