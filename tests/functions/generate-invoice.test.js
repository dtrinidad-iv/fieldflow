import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { createHandler, MIN_MS_FOR_CLEAR, MIN_MS_FOR_CREATE } from '../../functions/generate-invoice/handler.js';
import { PlatformError } from '../../lib/errors.js';
import { createMemoryStore, LEASE_MS } from '../../lib/idempotency.js';
import { verifyInvoiceLink } from '../../lib/links.js';
import { createMemoryPlatform } from '../../lib/platform/memory.js';
import { REQUIRED_FIELDS } from '../../lib/schema.js';

// Mapping: table ids T_<table>, slugs field_1, field_2, ... in REQUIRED_FIELDS order.
const schema = {
  tables: Object.fromEntries(
    Object.entries(REQUIRED_FIELDS).map(([t, f]) => [t, { id: `T_${t}`, fields: Object.fromEntries(Object.keys(f).map((n, i) => [n, `field_${i + 1}`])) }]),
  ),
};
const F = (table, name) => schema.tables[table].fields[name];
const SECRETS = { webhookSecret: 'test-webhook-secret', linkSecret: 'test-link-secret' };
const business = { name: 'Acme Field Services', addressLines: ['1 Main St'], email: 'billing@acme.test', currency: 'USD', locale: 'en-US', timeZone: 'UTC' };
const START = new Date('2026-11-03T15:00:00Z').getTime();
const DOMAIN = 'abc123.execute-api.us-east-1.amazonaws.com';

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';

function seed({
  status = 'Completed', items = 2, invoices = [], total = '$185.00', signature = SIGNATURE,
  customer = [{ id: 'cust1', val: 'Jane' }], technician = ['tech1'], unitPrice = 80, invoiceProblem,
} = {}) {
  return {
    T_jobs: [{ id: 'job42', [F('jobs', 'title')]: 'Fix boiler', [F('jobs', 'status')]: status, [F('jobs', 'customer')]: customer,
      [F('jobs', 'technician')]: technician, [F('jobs', 'scheduledDate')]: '2026-11-02', [F('jobs', 'total')]: total, [F('jobs', 'signature')]: signature,
      ...(invoiceProblem === undefined ? {} : { [F('jobs', 'invoiceProblem')]: invoiceProblem }) }],
    T_customers: [{ id: 'cust1', [F('customers', 'name')]: 'Jane Customer', [F('customers', 'email')]: 'jane@example.test' }],
    T_technicians: [{ id: 'tech1', [F('technicians', 'name')]: 'Sam Tech' }],
    T_jobItems: [
      ...Array.from({ length: items }, (_, i) => ({ id: `item${i}`, [F('jobItems', 'job')]: ['job42'], [F('jobItems', 'description')]: i ? 'Valve' : 'Labour',
        [F('jobItems', 'quantity')]: i ? 1 : 2, [F('jobItems', 'unitPrice')]: i ? '$25.00' : unitPrice })),
      { id: 'other', [F('jobItems', 'job')]: ['job99'], [F('jobItems', 'description')]: 'Someone else', [F('jobItems', 'quantity')]: 1, [F('jobItems', 'unitPrice')]: 999 },
    ],
    T_invoices: invoices,
  };
}

function setup(options = {}) {
  const platform = options.platform ?? createMemoryPlatform({ seed: seed(options) });
  const store = options.store ?? createMemoryStore();
  const files = new Map();
  const storage = { put: vi.fn(async (key, bytes, type) => files.set(key, { bytes, type })) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { now: START };
  const handler = createHandler({
    platform, schema, secrets: SECRETS, store, storage, business, region: 'us-east-1', now: () => new Date(clock.now), log, ...options.overrides,
  });
  return { handler, platform, store, storage, files, log, clock };
}

// secret null: no header at all.
const event = (body = { recordId: 'job42' }, secret = SECRETS.webhookSecret, domainName = DOMAIN) => ({
  headers: secret === null ? {} : { 'x-fieldflow-secret': secret },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  requestContext: { domainName },
});
const call = async (handler, e = event(), context = { getRemainingTimeInMillis: () => 20_000 }) => {
  const res = await handler(e, context);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const creates = (platform) => platform.calls.filter((c) => c.method === 'createRecord');
const invoicesIn = async (platform) => (await platform.listRecords('T_invoices')).items;

describe('generate-invoice', () => {
  it('renders the PDF, stores it, and creates the Invoices record with mapped fields and a signed link', async () => {
    const { handler, platform, files } = setup();
    const { status, body } = await call(handler);
    expect(status).toBe(201);
    expect(body).toMatchObject({ number: 'INV-job42', amount: 185 });
    expect(body.pdfLink.startsWith(`https://${DOMAIN}/invoices/job42.pdf?sig=`)).toBe(true);
    expect(verifyInvoiceLink('job42', new URL(body.pdfLink).searchParams.get('sig'), SECRETS.linkSecret)).toBe(true);

    const pdf = files.get('invoices/job42.pdf');
    expect(pdf.type).toBe('application/pdf');
    expect((await PDFDocument.load(pdf.bytes)).getTitle()).toBe('Invoice INV-job42');

    const [create] = creates(platform);
    expect(create.args).toEqual(['T_invoices', {
      [F('invoices', 'job')]: 'job42',
      [F('invoices', 'number')]: 'INV-job42',
      [F('invoices', 'issuedDate')]: '2026-11-03',
      [F('invoices', 'amount')]: 185,
      [F('invoices', 'pdfLink')]: body.pdfLink,
    }]);
  });

  it('ignores line items of other jobs even if the API filter returns them', async () => {
    const { handler } = setup();
    expect((await call(handler)).body.amount).toBe(185); // not 185 + 999
  });

  describe('exactly once', () => {
    it('creates one invoice and one PDF for a duplicate delivery, and answers the same both times', async () => {
      const { handler, platform, storage } = setup();
      const first = await call(handler);
      const second = await call(handler);
      expect(second).toEqual(first);
      expect(creates(platform)).toHaveLength(1);
      expect(storage.put).toHaveBeenCalledTimes(1);
    });

    it('answers 409 to a delivery that arrives while the first is still running', async () => {
      const { handler, store } = setup();
      await store.claim('invoice#job42', { now: START, leaseUntil: START + LEASE_MS, expiresAt: 1, token: 'other' });
      expect((await call(handler)).status).toBe(409);
    });

    it('never invoices a job that already has a connected invoice', async () => {
      const existing = { id: 'inv1', [F('invoices', 'job')]: ['job42'], [F('invoices', 'number')]: 'INV-job42' };
      const { handler, platform, storage } = setup({ invoices: [existing] });
      expect(await call(handler)).toEqual({ status: 200, body: { duplicate: true, invoiceId: 'inv1', number: 'INV-job42' } });
      expect(creates(platform)).toHaveLength(0);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('finds an existing invoice by its number when the connection filter finds nothing', async () => {
      const existing = { id: 'inv1', [F('invoices', 'job')]: 'Job #42 (display text)', [F('invoices', 'number')]: 'INV-job42' };
      const { handler, platform } = setup({ invoices: [existing] });
      expect((await call(handler)).body).toMatchObject({ duplicate: true, invoiceId: 'inv1' });
      expect(creates(platform)).toHaveLength(0);
    });

    it('keeps one invoice when the create succeeds upstream but the call fails (e.g. a timeout)', async () => {
      const { handler, platform, clock } = setup();
      const realCreate = platform.createRecord;
      platform.createRecord = vi.fn(async (...args) => {
        await realCreate(...args); // the record is written...
        throw new PlatformError(0, 'createRecord'); // ...but the response never arrives
      });
      expect((await call(handler)).status).toBe(502);
      platform.createRecord = realCreate;
      expect((await call(handler)).status).toBe(409); // the claim is kept while the lease runs
      clock.now += LEASE_MS + 1;
      expect((await call(handler)).body).toMatchObject({ duplicate: true });
      expect(await invoicesIn(platform)).toHaveLength(1);
    });

    it('keeps one invoice when the result could not be stored, after the lease expires', async () => {
      const store = createMemoryStore();
      const complete = store.complete;
      store.complete = vi.fn().mockRejectedValueOnce(new Error('DynamoDB throttled')).mockImplementation(complete);
      const { handler, platform, clock } = setup({ store });
      expect((await call(handler)).status).toBe(500);
      clock.now += LEASE_MS + 1;
      expect((await call(handler)).body).toMatchObject({ duplicate: true });
      expect(await invoicesIn(platform)).toHaveLength(1);
    });

    it('does not start the create with too little time left, and a retry then succeeds', async () => {
      const { handler, platform } = setup();
      const res = await call(handler, event(), { getRemainingTimeInMillis: () => MIN_MS_FOR_CREATE - 1 });
      expect(res.status).toBe(503);
      expect(creates(platform)).toHaveLength(0);
      expect((await call(handler)).status).toBe(201);
    });
  });

  describe('rejects', () => {
    it.each([
      ['a missing secret', event(undefined, null)],
      ['a wrong secret', event(undefined, 'nope')],
    ])('%s with 401, before reading anything', async (_, e) => {
      const { handler, platform } = setup();
      expect((await call(handler, e)).status).toBe(401);
      expect(platform.calls).toEqual([]);
    });

    it.each([
      ['an empty body', ''],
      ['invalid JSON', '{nope'],
      ['no recordId', {}],
      ['a bad recordId', { recordId: '../etc' }],
    ])('%s with 400', async (_, body) => {
      const { handler } = setup();
      expect((await call(handler, event(body))).status).toBe(400);
    });

    it('a missing job with 404', async () => {
      const { handler } = setup();
      expect((await call(handler, event({ recordId: 'job0' }))).status).toBe(404);
    });

    it.each([
      ['no signature', null],
      ['an empty signature', ''],
      ['text instead of an image', 'signed by phone'],
      ['an SVG instead of a PNG', 'data:image/svg+xml;base64,PHN2Zz4='],
      ['a signature over 100 KB', `data:image/png;base64,${'A'.repeat(100_000)}`],
    ])('a Completed job with %s with 422, creating nothing', async (_, signature) => {
      const { handler, platform, storage } = setup({ signature });
      expect(await call(handler)).toEqual({ status: 422, body: { error: 'job has no signature', sentBack: true } });
      expect(creates(platform)).toHaveLength(0);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('a job without line items with 422', async () => {
      const { handler } = setup({ items: 0 });
      expect((await call(handler)).status).toBe(422);
    });

    it('a job whose Total disagrees with its line items with 422, logging only the job id', async () => {
      const { handler, platform, log, storage } = setup({ total: '$999.00' });
      expect(await call(handler)).toEqual({ status: 422, body: { error: 'job total differs from its line items', sentBack: true } });
      expect(log.warn).toHaveBeenCalledWith('job total differs from its line items', { jobId: 'job42' });
      expect(creates(platform)).toHaveLength(0);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it.each(['evil.example.com', 'abc123.execute-api.eu-west-1.amazonaws.com', 'a.b.execute-api.us-east-1.amazonaws.com', ''])(
      'a request from the domain %j (links must point at this API)',
      async (domain) => {
        const { handler, platform } = setup();
        expect((await call(handler, event(undefined, undefined, domain))).status).toBe(500);
        expect(creates(platform)).toHaveLength(0);
      },
    );
  });

  describe('sends back a job that is not ready to invoice (plan 07)', () => {
    const jobOf = async (platform) => platform.getRecord('T_jobs', 'job42');

    it.each([
      ['no signature', { signature: '' }, 'job has no signature'],
      ['no customer', { customer: null }, 'job has no customer'],
      ['a missing customer', { customer: ['cust0'] }, 'job customer not found'],
      ['no technician', { technician: null }, 'job has no technician'],
      ['a missing technician', { technician: ['tech0'] }, 'job technician not found'],
      ['no line items', { items: 0 }, 'job has no line items'],
      ['an unreadable amount', { unitPrice: '1.234,50' }, 'item 1 unit price is not an amount like 1234.50'],
      ['a Total mismatch', { total: '$999.00' }, 'job total differs from its line items'],
    ])('%s: back to In Progress with the reason, nothing created, nothing remembered', async (_, options, reason) => {
      const { handler, platform, storage, store } = setup(options);
      expect(await call(handler)).toEqual({ status: 422, body: { error: reason, sentBack: true } });
      const job = await jobOf(platform);
      expect(job[F('jobs', 'status')]).toBe('In Progress');
      expect(job[F('jobs', 'invoiceProblem')]).toBe(`Not invoiced: ${reason}. Fix it and complete the job again.`);
      expect(creates(platform)).toHaveLength(0);
      expect(storage.put).not.toHaveBeenCalled();
      expect(store.items.size).toBe(0); // the claim is released, not stored
    });

    it('once fixed and completed again, the job is invoiced and the problem cleared', async () => {
      const { handler, platform } = setup({ signature: '' });
      expect((await call(handler)).status).toBe(422);
      await platform.updateRecord('T_jobs', 'job42', { [F('jobs', 'signature')]: SIGNATURE, [F('jobs', 'status')]: 'Completed' });
      expect((await call(handler)).status).toBe(201);
      expect((await jobOf(platform))[F('jobs', 'invoiceProblem')]).toBe('');
    });

    it.each(['getRecord', 'listRecords'])('an upstream 422 from %s is an app failure (502), never a send-back', async (method) => {
      const { handler, platform } = setup();
      // getRecord: let the job read succeed, then fail the customer read.
      if (method === 'getRecord') {
        const real = platform.getRecord;
        let n = 0;
        platform.getRecord = (...args) => (++n === 2 ? Promise.reject(new PlatformError(422, 'getRecord')) : real(...args));
      } else {
        // The first two lists are the existing-invoice lookups; the third is the job items.
        const real = platform.listRecords;
        let n = 0;
        platform.listRecords = (...args) => (++n === 3 ? Promise.reject(new PlatformError(422, 'listRecords')) : real(...args));
      }
      expect(await call(handler)).toEqual({ status: 502, body: { error: 'upstream platform error' } });
      expect(platform.calls.filter((c) => c.method === 'updateRecord')).toHaveLength(0);
      expect((await jobOf(platform))[F('jobs', 'status')]).toBe('Completed');
    });

    it('a failed send-back write answers 502 and releases the claim, so a retry writes it', async () => {
      const { handler, platform, store } = setup({ items: 0 });
      platform.failNext('updateRecord');
      expect((await call(handler)).status).toBe(502);
      expect(store.items.size).toBe(0);
      expect((await call(handler)).status).toBe(422);
      expect((await jobOf(platform))[F('jobs', 'status')]).toBe('In Progress');
    });

    it('does not touch Invoice Problem after a create when it is already empty', async () => {
      const { handler, platform } = setup();
      expect((await call(handler)).status).toBe(201);
      expect(platform.calls.filter((c) => c.method === 'updateRecord')).toHaveLength(0);
    });

    it('a failed clear, or too little time to clear, never fails the invoice', async () => {
      const failing = setup({ invoiceProblem: 'Not invoiced: old' });
      failing.platform.failNext('updateRecord');
      expect((await call(failing.handler)).status).toBe(201);
      expect(failing.log.warn).toHaveBeenCalledWith('invoice problem not cleared', { jobId: 'job42' });

      const late = setup({ invoiceProblem: 'Not invoiced: old' });
      let calls = 0;
      // Plenty of time for the create, then too little for the clear.
      const context = { getRemainingTimeInMillis: () => (++calls > 1 ? MIN_MS_FOR_CLEAR - 1 : 20_000) };
      expect((await call(late.handler, event(), context)).status).toBe(201);
      expect(late.log.warn).toHaveBeenCalledWith('invoice problem not cleared: not enough time left', { jobId: 'job42' });
    });
  });

  it('skips a job that is not Completed, without remembering it, so it is invoiced once it is', async () => {
    const { handler, platform } = setup({ status: 'In Progress' });
    expect(await call(handler)).toEqual({ status: 200, body: { skipped: 'job is not Completed' } });
    await platform.updateRecord('T_jobs', 'job42', { [F('jobs', 'status')]: 'Completed' });
    expect((await call(handler)).status).toBe(201);
  });

  it('answers 502 on a platform failure before anything is created, and a retry then succeeds', async () => {
    const { handler, platform } = setup();
    platform.failNext('getRecord');
    expect((await call(handler)).status).toBe(502);
    expect((await call(handler)).status).toBe(201);
    expect(await invoicesIn(platform)).toHaveLength(1);
  });

  it('refuses to invoice with placeholder business details', async () => {
    const { handler } = setup({ overrides: { business: { ...business, placeholder: true } } });
    expect(await call(handler)).toEqual({ status: 500, body: { error: 'internal error' } });
  });
});
