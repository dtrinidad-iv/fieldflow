// Invoice data from a job, its customer, technician and line items. Pure: no I/O, so every
// rounding rule is tested directly. Money is integer cents from the moment it's parsed, and line
// totals are computed in integers (quantity in thousandths), never with float products.
import { HttpError } from './errors.js';

export const MAX_LINE_ITEMS = 200;
const unprocessable = (message) => new HttpError(422, message);

// Amounts as Tadabase returns them: a number, or a US-formatted string like "$1,234.50".
// Anything else (a comma decimal, more than 2 decimals, accounting brackets) is rejected rather
// than guessed: "1.234,50" must never become 1.23.
export function parseMoneyCents(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.round(value * 100) !== Number((value * 100).toFixed(6))) {
      throw unprocessable(`${label} is not an amount with at most 2 decimals`);
    }
    return Math.round(value * 100);
  }
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-');
  const unsigned = (negative ? text.slice(1) : text).replace(/^\$/, '');
  const [whole, fraction = '', extra] = unsigned.split('.');
  const groups = whole.split(',');
  const wholeOk =
    groups.length === 1 ? /^\d+$/.test(whole) : /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every((g) => /^\d{3}$/.test(g));
  if (!wholeOk || extra !== undefined || !/^\d{0,2}$/.test(fraction) || (unsigned.includes('.') && fraction === '')) {
    throw unprocessable(`${label} is not an amount like 1234.50`);
  }
  const cents = Number(groups.join('')) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

// Quantities: up to 3 decimals (e.g. 1.25 hours), returned in thousandths.
export function parseQuantityMilli(value, label) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+$|^\d+\.\d{1,3}$/.test(text)) throw unprocessable(`${label} is not a quantity with at most 3 decimals`);
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
}

// A connection field can come back as an id, an array of ids, or objects with an id.
export function connectionId(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof first.id === 'string') return first.id;
  return undefined;
}

// The customer's signature, as the signature pad saves it (widgets/signature-pad.js): a PNG data
// URL under 100 KB. A job is invoiced only when it has one, however its Status became Completed
// (the form, a board drag, an inline edit).
export const MAX_SIGNATURE_LENGTH = 100000;
const SIGNATURE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
export function hasSignature(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= MAX_SIGNATURE_LENGTH && SIGNATURE.test(text);
}

// Derived from the job alone, so every retry produces the same number (and the same S3 key).
export const invoiceNumber = (jobId) => `INV-${jobId}`;

// YYYY-MM-DD in the business's time zone (a job completed on Dec 31 in New York is dated Dec 31).
export function localDate(at, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

// job, customer, technician and items are logical records (lib/schema.js toLogical).
export function buildInvoice({ job, customer, technician, items, business, issuedAt }) {
  if (items.length > MAX_LINE_ITEMS) throw unprocessable(`job has more than ${MAX_LINE_ITEMS} line items`);
  const lines = items.map((item, i) => {
    const label = `item ${i + 1}`;
    const quantityMilli = parseQuantityMilli(item.quantity, `${label} quantity`);
    const unitCents = parseMoneyCents(item.unitPrice, `${label} unit price`);
    if (unitCents < 0) throw unprocessable(`${label} unit price is negative`);
    return {
      description: String(item.description ?? '').trim() || '(no description)',
      quantity: quantityMilli / 1000,
      unitCents,
      lineCents: Math.floor((quantityMilli * unitCents + 500) / 1000), // half-up, in integers
    };
  });
  return {
    number: invoiceNumber(job.id),
    issuedDate: localDate(issuedAt, business.timeZone),
    jobId: job.id,
    jobTitle: String(job.title ?? ''),
    scheduledDate: job.scheduledDate ? String(job.scheduledDate) : '',
    technician: technician?.name ? String(technician.name) : '',
    customer: {
      name: String(customer?.name ?? ''),
      email: String(customer?.email ?? ''),
      address: formatAddress(customer?.address),
    },
    business,
    lines,
    totalCents: lines.reduce((sum, l) => sum + l.lineCents, 0),
  };
}

// Address fields may be a string or an object of parts.
function formatAddress(address) {
  if (!address) return [];
  if (typeof address === 'string') return address.split(/\r?\n|,\s*/).filter(Boolean);
  const { address: street, address2, city, state, zip, country } = address;
  return [street, address2, [city, state, zip].filter(Boolean).join(' '), country].filter(Boolean).map(String);
}

export function formatMoney(cents, { currency = 'USD', locale = 'en-US' } = {}) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100).replace(/[\u00a0\u202f]/g, ' ');
}
