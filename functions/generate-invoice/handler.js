// POST /webhooks/job-completed: Tadabase calls this when a job's Status becomes Completed
// (webhook body: {"recordId": "{record_id}"}). It renders the job's invoice as a PDF, stores it in
// S3 and creates the Invoices record with a signed link to it, exactly once per job:
// - an idempotency claim (lib/idempotency.js) serialises deliveries and replays the result
// - before anything is created, the app is searched for an existing invoice, by its connection
//   to the job and by its number (INV-<jobId>), so a lost result never leads to a second invoice
// - once the create has been attempted, the claim is kept even on failure (the record may exist)
// - the create is skipped when too little time is left, so a timeout can't cut it in half
import business from '../../config/invoice.json' with { type: 'json' };
import { dynamoClient, createS3Storage } from '../../lib/aws.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { parseJsonBody, wrap } from '../../lib/http.js';
import { createDynamoStore, withIdempotency } from '../../lib/idempotency.js';
import { buildInvoice, connectionId, invoiceNumber, parseMoneyCents } from '../../lib/invoice.js';
import { invoiceLink } from '../../lib/links.js';
import { createLogger } from '../../lib/log.js';
import { renderInvoicePdf } from '../../lib/pdf.js';
import { getRuntime } from '../../lib/runtime.js';
import { fieldsOf, tableId, toLogical, toSlugs } from '../../lib/schema.js';
import { requireId } from '../../lib/validate.js';
import { verifySecret } from '../../lib/webhook.js';

const COMPLETED = 'Completed';
// One Tadabase write (5 s timeout) plus margin must fit in what's left of the invocation.
export const MIN_MS_FOR_CREATE = 8000;
const resolve = (dep) => (typeof dep === 'function' ? dep() : dep);

// The function's own public URL, for the PDF link. API Gateway puts its domain in the request
// context (the template can't pass the API URL in: that would be a circular reference). Only an
// execute-api domain of this region is accepted, so a forwarded Host can't redirect the links.
function publicBaseUrl(event, region) {
  const domain = String(event?.requestContext?.domainName ?? '').toLowerCase();
  const suffix = `.execute-api.${region}.amazonaws.com`;
  const id = domain.endsWith(suffix) ? domain.slice(0, -suffix.length) : '';
  if (!region || !/^[a-z0-9]{1,32}$/.test(id)) throw new Error('request has no API Gateway domain for this region');
  return `https://${domain}`;
}

// The job's existing invoice, if any: by the `job` connection (filtered by the API, checked
// again here) or by its deterministic number, which doesn't depend on how connections filter.
async function findInvoice(platform, schema, jobId, number) {
  const fields = fieldsOf(schema, 'invoices');
  const table = tableId(schema, 'invoices');
  const byJob = await platform.listAllRecords(table, { filters: [{ field: fields.job, operator: 'is', value: jobId }] });
  const byNumber = await platform.listAllRecords(table, { filters: [{ field: fields.number, operator: 'is', value: number }] });
  return [...byJob, ...byNumber]
    .map((r) => toLogical(schema, 'invoices', r))
    .find((r) => connectionId(r.job) === jobId || r.number === number);
}

async function jobItems(platform, schema, jobId) {
  const rows = await platform.listAllRecords(tableId(schema, 'jobItems'), {
    filters: [{ field: fieldsOf(schema, 'jobItems').job, operator: 'is', value: jobId }],
  });
  return rows.map((r) => toLogical(schema, 'jobItems', r)).filter((r) => connectionId(r.job) === jobId);
}

async function generate({ jobId, platform, schema, storage, business: biz, linkSecret, baseUrl, now, remainingMs, log }) {
  const raw = await platform.getRecord(tableId(schema, 'jobs'), jobId);
  if (!raw) throw notFound('job not found');
  const job = toLogical(schema, 'jobs', raw);
  if (job.status !== COMPLETED) {
    // Not final: the job may be completed later, so this answer is not stored.
    return { store: false, value: { status: 200, body: { skipped: 'job is not Completed' } } };
  }

  const number = invoiceNumber(jobId);
  const existing = await findInvoice(platform, schema, jobId, number);
  if (existing) {
    return { store: true, value: { status: 200, body: { duplicate: true, invoiceId: existing.id, number: existing.number ?? number } } };
  }

  const customerId = connectionId(job.customer);
  if (!customerId) throw new HttpError(422, 'job has no customer');
  const customerRaw = await platform.getRecord(tableId(schema, 'customers'), customerId);
  if (!customerRaw) throw new HttpError(422, 'job customer not found');
  const technicianId = connectionId(job.technician);
  const technicianRaw = technicianId ? await platform.getRecord(tableId(schema, 'technicians'), technicianId) : null;
  const items = await jobItems(platform, schema, jobId);
  if (!items.length) throw new HttpError(422, 'job has no line items');

  const invoice = buildInvoice({
    job,
    customer: toLogical(schema, 'customers', customerRaw),
    technician: technicianRaw && toLogical(schema, 'technicians', technicianRaw),
    items,
    business: biz,
    issuedAt: now(),
  });
  // The app's own Total (a formula field) must agree with the line items; if not, something is
  // off in the data, and no invoice is better than a wrong one.
  if (job.total !== undefined && job.total !== null && job.total !== '') {
    if (parseMoneyCents(job.total, 'job total') !== invoice.totalCents) {
      log.warn('job total differs from its line items', { jobId });
      throw new HttpError(422, 'job total differs from its line items');
    }
  }

  await storage.put(`invoices/${jobId}.pdf`, await renderInvoicePdf(invoice), 'application/pdf');
  if (remainingMs() < MIN_MS_FOR_CREATE) {
    throw new HttpError(503, 'not enough time left to create the invoice; retry'); // nothing created yet
  }
  const pdfLink = invoiceLink(baseUrl, jobId, linkSecret);
  const amount = invoice.totalCents / 100;
  let id;
  try {
    ({ id } = await platform.createRecord(
      tableId(schema, 'invoices'),
      toSlugs(schema, 'invoices', { job: jobId, number, issuedDate: invoice.issuedDate, amount, pdfLink }),
    ));
  } catch (err) {
    // The record may have been created even though the call failed (e.g. a timeout after the
    // write). Keep the claim: a retry after the lease finds the invoice through findInvoice.
    err.keepClaim = true;
    throw err;
  }
  log.info('invoice created', { jobId, invoiceId: id });
  return { store: true, value: { status: 201, body: { invoiceId: id, number, amount, pdfLink } } };
}

export function createHandler({
  platform,
  schema,
  secrets,
  store,
  storage,
  business: biz,
  region = process.env.AWS_REGION,
  now = () => new Date(),
  log = createLogger({ fn: 'generate-invoice' }),
}) {
  return wrap(async (event, context) => {
    const { webhookSecret, linkSecret } = await resolve(secrets);
    verifySecret(event, webhookSecret, log);
    const jobId = requireId(parseJsonBody(event), 'recordId');
    const baseUrl = publicBaseUrl(event, region);
    const deps = {
      platform: await resolve(platform),
      schema: await resolve(schema),
      storage: await resolve(storage),
      business: await resolve(biz),
    };
    if (deps.business.placeholder) throw new Error('config/invoice.json still holds placeholder business details');
    const remainingMs = () => (typeof context?.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : Infinity);
    const { value } = await withIdempotency(
      await resolve(store),
      `invoice#${jobId}`,
      () => generate({ jobId, ...deps, linkSecret, baseUrl, now, remainingMs, log }),
      { now: () => now().getTime() },
    );
    return value;
  }, { log });
}

// Deployed: everything is built lazily inside the request, so a setup problem (placeholder
// mapping, missing env) becomes a logged 500 response instead of a crashed cold start.
export const handler = createHandler({
  platform: () => getRuntime().platform(),
  schema: () => getRuntime().schema,
  secrets: () => getRuntime().secrets(),
  store: async () => {
    const { client, commands } = await dynamoClient();
    return createDynamoStore({ client, commands, tableName: process.env.IDEMPOTENCY_TABLE });
  },
  storage: () => createS3Storage({ bucket: process.env.INVOICES_BUCKET }),
  business,
});
