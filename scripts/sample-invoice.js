// A sample invoice PDF with fake data, rendered by the real renderer (lib/invoice.js + lib/pdf.js):
//
//   npm run demo:invoice            -> sample-invoice.pdf (gitignored)
//   node scripts/sample-invoice.js out.pdf
//
// No accounts, no network. The business and customer are fictional.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildInvoice } from '../lib/invoice.js';
import { renderInvoicePdf } from '../lib/pdf.js';

export const DEMO_BUSINESS = {
  name: 'Northwind Field Services',
  addressLines: ['100 Harbor Way, Suite 4', 'Springfield, ST 00000'],
  email: 'billing@northwind.example',
  currency: 'USD',
  locale: 'en-US',
  timeZone: 'America/New_York',
};

export function sampleInvoicePdf(issuedAt = new Date()) {
  const invoice = buildInvoice({
    job: { id: 'job1042', title: 'Replace water heater', scheduledDate: '2026-11-03' },
    customer: {
      name: 'Jane Rivera',
      email: 'jane.rivera@example.com',
      address: { address: '12 Maple Lane', city: 'Springfield', state: 'ST', zip: '00000' },
    },
    technician: { name: 'Alex Moreno' },
    items: [
      { description: 'Labour (hours)', quantity: '2.5', unitPrice: '$80.00' },
      { description: '50-gallon water heater', quantity: '1', unitPrice: '$649.00' },
      { description: 'Expansion tank and fittings', quantity: '1', unitPrice: '$45.50' },
      { description: 'Haul-away and disposal of old unit', quantity: '1', unitPrice: '$35.00' },
    ],
    business: DEMO_BUSINESS,
    issuedAt,
  });
  return renderInvoicePdf(invoice);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.argv[2] ?? 'sample-invoice.pdf';
  sampleInvoicePdf()
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path is the user's own CLI argument
    .then((bytes) => writeFile(out, bytes))
    .then(() => console.log(`Wrote ${out}`))
    .catch((err) => {
      console.error(`sample-invoice failed: ${err.message}`);
      process.exit(1);
    });
}
