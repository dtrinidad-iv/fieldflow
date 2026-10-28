import { describe, expect, it, vi } from 'vitest';
import { createHandler } from '../../functions/invoice-pdf/handler.js';
import { signInvoiceLink } from '../../lib/links.js';

const SECRET = 'test-link-secret';
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49]); // "%PDF-1"

function setup({ bytes = PDF } = {}) {
  const storage = { get: vi.fn(async () => bytes) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { storage, handler: createHandler({ secrets: { linkSecret: SECRET }, storage, log }) };
}
const event = (file, sig) => ({ pathParameters: { file }, queryStringParameters: sig === undefined ? undefined : { sig } });

describe('invoice-pdf', () => {
  it('returns the PDF for a valid link, never cached and never sniffed', async () => {
    const { handler, storage } = setup();
    const res = await handler(event('job42.pdf', signInvoiceLink('job42', SECRET)));
    expect(res.statusCode).toBe(200);
    expect(res.isBase64Encoded).toBe(true);
    expect(Buffer.from(res.body, 'base64')).toEqual(Buffer.from(PDF));
    expect(res.headers).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="INV-job42.pdf"',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(storage.get).toHaveBeenCalledWith('invoices/job42.pdf');
  });

  it.each([
    ['a missing signature', undefined],
    ['a wrong signature', signInvoiceLink('job43', SECRET)],
    ['a signature made with another secret', signInvoiceLink('job42', 'other')],
  ])('answers 403 to %s, without touching S3', async (_, sig) => {
    const { handler, storage } = setup();
    expect((await handler(event('job42.pdf', sig))).statusCode).toBe(403);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it.each(['job42', 'job42.txt', '../job42.pdf', '..%2Fjob42.pdf', '.pdf', `${'x'.repeat(65)}.pdf`, undefined])(
    'answers 400 to the file %j',
    async (file) => {
      const { handler } = setup();
      expect((await handler(event(file, 'x'))).statusCode).toBe(400);
    },
  );

  it('answers 404 when the invoice was never generated', async () => {
    const { handler } = setup({ bytes: null });
    expect((await handler(event('job42.pdf', signInvoiceLink('job42', SECRET)))).statusCode).toBe(404);
  });
});
