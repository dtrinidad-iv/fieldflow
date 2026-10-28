// GET /invoices/<jobId>.pdf?sig=...: the stable link stored in the Invoices record. Checks the
// link's HMAC, then returns the PDF from the private bucket. (Served by the function rather than
// redirected to a presigned S3 URL: no extra dependency, and invoices are a few KB, far below
// Lambda's 6 MB response limit.) No Tadabase call; the link secret is its only secret.
import { createS3Storage } from '../../lib/aws.js';
import { readConfig } from '../../lib/config.js';
import { badRequest, HttpError, notFound } from '../../lib/errors.js';
import { wrap } from '../../lib/http.js';
import { verifyInvoiceLink } from '../../lib/links.js';
import { createLogger } from '../../lib/log.js';
import { createSecretLoader } from '../../lib/secrets.js';

const FILE = /^([A-Za-z0-9_-]{1,64})\.pdf$/;
const resolve = (dep) => (typeof dep === 'function' ? dep() : dep);

export function createHandler({ secrets, storage, log = createLogger({ fn: 'invoice-pdf' }) }) {
  return wrap(async (event) => {
    const match = FILE.exec(event?.pathParameters?.file ?? '');
    if (!match) throw badRequest('expected /invoices/<jobId>.pdf');
    const jobId = match[1];
    const { linkSecret } = await resolve(secrets);
    if (!verifyInvoiceLink(jobId, event.queryStringParameters?.sig, linkSecret)) {
      throw new HttpError(403, 'invalid or missing link signature');
    }
    const bytes = await (await resolve(storage)).get(`invoices/${jobId}.pdf`);
    if (!bytes) throw notFound('invoice not found');
    return {
      raw: {
        statusCode: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="INV-${jobId}.pdf"`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
        isBase64Encoded: true,
        body: Buffer.from(bytes).toString('base64'),
      },
    };
  }, { log });
}

let loader;
export const handler = createHandler({
  secrets: () => {
    loader ??= createSecretLoader({ stage: readConfig(process.env).stage, keys: ['linkSecret'] });
    return loader.load();
  },
  storage: () => createS3Storage({ bucket: process.env.INVOICES_BUCKET }),
});
