// Renders an invoice (lib/invoice.js buildInvoice) to PDF bytes with pdf-lib and the standard
// Helvetica fonts, so no font files ship. Characters those fonts can't encode become "?".
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { formatMoney } from './invoice.js';

const PAGE = { width: 612, height: 792, margin: 50 }; // US Letter, in points
const GREY = rgb(0.4, 0.4, 0.4);
const COLUMNS = { description: 50, quantity: 360, unit: 420, total: 562 }; // total is right-aligned

// Record text is cut to this length before it's measured or drawn, so one huge field can't make
// rendering (or fit()'s shortening loop) slow enough to time out.
export const MAX_TEXT = 200;

function encoder(font) {
  const ok = new Map();
  return (text) =>
    [...String(text ?? '').slice(0, MAX_TEXT)]
      .map((ch) => {
        if (!ok.has(ch)) {
          try {
            font.encodeText(ch);
            ok.set(ch, true);
          } catch {
            ok.set(ch, false);
          }
        }
        return ok.get(ch) ? ch : '?';
      })
      .join('');
}

function fit(text, font, size, width) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > width) out = out.slice(0, -1);
  return `${out}...`;
}

export async function renderInvoicePdf(invoice) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${invoice.number}`);
  doc.setProducer('FieldFlow');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = encoder(font);
  const money = (cents) => clean(formatMoney(cents, invoice.business));

  let page;
  let y;
  const text = (value, x, size = 10, { f = font, color, right } = {}) => {
    const t = clean(value);
    const at = right ? x - f.widthOfTextAtSize(t, size) : x;
    page.drawText(t, { x: at, y, size, font: f, color });
  };
  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - PAGE.margin;
  };
  const tableHeader = () => {
    text('Description', COLUMNS.description, 9, { f: bold });
    text('Qty', COLUMNS.quantity, 9, { f: bold });
    text('Unit price', COLUMNS.unit, 9, { f: bold });
    text('Amount', COLUMNS.total, 9, { f: bold, right: true });
    y -= 6;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 0.5, color: GREY });
    y -= 14;
  };

  newPage();
  const { business, customer } = invoice;
  text(business.name, PAGE.margin, 18, { f: bold });
  text('INVOICE', PAGE.width - PAGE.margin, 18, { f: bold, right: true });
  y -= 18;
  for (const line of [...(business.addressLines ?? []), business.email].filter(Boolean)) {
    text(line, PAGE.margin, 9, { color: GREY });
    y -= 12;
  }

  y -= 16;
  const top = y;
  text('Bill to', PAGE.margin, 9, { f: bold });
  y -= 14;
  for (const line of [customer.name, ...customer.address, customer.email].filter(Boolean)) {
    text(line, PAGE.margin, 10);
    y -= 13;
  }
  const leftBottom = y;
  y = top;
  for (const [label, value] of [
    ['Invoice', invoice.number],
    ['Issued', invoice.issuedDate],
    ['Job', invoice.jobTitle],
    ['Scheduled', invoice.scheduledDate],
    ['Technician', invoice.technician],
  ]) {
    if (!value) continue;
    text(label, 340, 9, { f: bold });
    text(fit(clean(value), font, 10, 160), PAGE.width - PAGE.margin, 10, { right: true });
    y -= 14;
  }
  y = Math.min(y, leftBottom) - 20;

  tableHeader();
  for (const line of invoice.lines) {
    if (y < PAGE.margin + 40) {
      newPage();
      tableHeader();
    }
    text(fit(clean(line.description), font, 10, COLUMNS.quantity - COLUMNS.description - 10), COLUMNS.description, 10);
    text(String(line.quantity), COLUMNS.quantity, 10);
    text(money(line.unitCents), COLUMNS.unit, 10);
    text(money(line.lineCents), COLUMNS.total, 10, { right: true });
    y -= 16;
  }

  if (y < PAGE.margin + 40) newPage();
  y -= 4;
  page.drawLine({ start: { x: 340, y: y + 10 }, end: { x: PAGE.width - PAGE.margin, y: y + 10 }, thickness: 0.5, color: GREY });
  text('Total', 340, 12, { f: bold });
  text(money(invoice.totalCents), COLUMNS.total, 12, { f: bold, right: true });

  return doc.save();
}
