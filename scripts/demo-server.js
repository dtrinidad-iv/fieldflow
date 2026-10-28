// Local client demo (plan 09): the real FieldFlow functions, running against an in-memory stand-in
// for Tadabase, behind a small web page. No accounts, no network, nothing leaves this machine.
//
//   npm run demo            -> http://127.0.0.1:5173
//
// What's real: generate-invoice, invoice-pdf and check-schedule (their createHandler, the same code
// that deploys to Lambda), lib/ (money rules, PDF renderer, signed links, idempotency) and both
// widgets. What's a stand-in: the platform (lib/platform/memory.js, which the tests use), the PDF
// store (a Map instead of S3), and this server, which does what the Tadabase app would: call the
// webhooks after a change, apply the record rule, compute the formula fields.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandler as createCheckSchedule } from '../functions/check-schedule/handler.js';
import { createHandler as createGenerateInvoice } from '../functions/generate-invoice/handler.js';
import { createHandler as createInvoicePdf } from '../functions/invoice-pdf/handler.js';
import { createMemoryStore } from '../lib/idempotency.js';
import { connectionId, MAX_SIGNATURE_LENGTH, parseMoneyCents, parseQuantityMilli } from '../lib/invoice.js';
import { createMemoryPlatform } from '../lib/platform/memory.js';
import { REQUIRED_FIELDS, tableId, toLogical, toSlugs } from '../lib/schema.js';
import { DEMO_BUSINESS, sampleInvoicePdf } from './sample-invoice.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 256 * 1024;
export const MAX_ITEMS_PER_JOB = 50;
export const MAX_ITEMS = 500;
// generate-invoice only builds links for an API Gateway domain (a real safety check, kept as is).
// The demo hands it this stand-in domain; the page opens the link's path on localhost instead.
export const DEMO_DOMAIN = 'demo.execute-api.us-east-1.amazonaws.com';
const OPEN = ['Scheduled', 'In Progress'];
const SLOTS = ['Morning', 'Afternoon', 'Evening'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// Only these files are served: no request path ever reaches the file system.
const STATIC = {
  '/': ['demo/app.html', 'text/html; charset=utf-8'],
  '/app.js': ['demo/app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['demo/app.css', 'text/css; charset=utf-8'],
  '/widgets/signature-pad.js': ['widgets/signature-pad.js', 'text/javascript; charset=utf-8'],
  '/widgets/signature-pad.css': ['widgets/signature-pad.css', 'text/css; charset=utf-8'],
  '/widgets/line-total.js': ['widgets/line-total.js', 'text/javascript; charset=utf-8'],
  '/widgets/line-total.css': ['widgets/line-total.css', 'text/css; charset=utf-8'],
};

// The same mapping shape as config/tadabase.<stage>.json: table T_<name>, slugs field_1, field_2...
const schema = {
  tables: Object.fromEntries(
    Object.entries(REQUIRED_FIELDS).map(([t, f]) => [t, { id: `T_${t}`, fields: Object.fromEntries(Object.keys(f).map((n, i) => [n, `field_${i + 1}`])) }]),
  ),
};
const T = (table) => tableId(schema, table);
const raw = (table, values) => toSlugs(schema, table, values);

const day = (offset, now = new Date()) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

function seed(now) {
  const job = (id, title, customer, technician, offset, slot, status) =>
    ({ id, ...raw('jobs', { title, customer: [customer], technician: [technician], scheduledDate: day(offset, now), slot, status }) });
  const item = (id, jobId, description, quantity, unitPrice) =>
    ({ id, ...raw('jobItems', { job: [jobId], description, quantity, unitPrice }) });
  return {
    T_customers: [
      { id: 'cust1', ...raw('customers', { name: 'Jane Rivera', email: 'jane.rivera@example.com', address: '12 Maple Lane, Springfield ST 00000' }) },
      { id: 'cust2', ...raw('customers', { name: 'Harbor Cafe', email: 'owner@harborcafe.example', address: '8 Pier Road, Springfield ST 00000' }) },
      { id: 'cust3', ...raw('customers', { name: 'Tom Okafor', email: 'tom.okafor@example.com', address: '41 Birch Street, Springfield ST 00000' }) },
    ],
    T_technicians: [
      { id: 'tech1', ...raw('technicians', { name: 'Alex Moreno', email: 'alex@northwind.example' }) },
      { id: 'tech2', ...raw('technicians', { name: 'Sam Lee', email: 'sam@northwind.example' }) },
      { id: 'tech3', ...raw('technicians', { name: 'Priya Shah', email: 'priya@northwind.example' }) },
    ],
    T_jobs: [
      job('job1', 'Replace water heater', 'cust1', 'tech1', 1, 'Morning', 'Scheduled'),
      job('job2', 'Annual boiler service', 'cust2', 'tech2', 1, 'Afternoon', 'In Progress'),
      job('job3', 'Fix leaking tap', 'cust3', 'tech1', 1, 'Afternoon', 'Scheduled'),
      job('job4', 'Install smart thermostat', 'cust1', 'tech3', 2, 'Morning', 'Scheduled'),
    ],
    T_jobItems: [
      item('item1', 'job1', 'Labour (hours)', '2.5', '$80.00'),
      item('item2', 'job1', '50-gallon water heater', '1', '$649.00'),
      item('item3', 'job2', 'Boiler service', '1', '$120.00'),
      item('item4', 'job4', 'Smart thermostat, installed', '1', '$189.00'),
    ],
    T_invoices: [],
  };
}

// An error the page should see (4xx). Anything else becomes a plain 500.
const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

// A formula field's number from a text value, the way Tadabase reads one: "$1,234.50" -> 1234.5.
const formulaNumber = (value) => Number(String(value ?? '').replace(/[$,\s]/g, '')) || 0;

export function createDemo({ now = () => new Date() } = {}) {
  let platform;
  let store;
  let files;
  let handlers;
  let log;
  let settling;
  // One change at a time, as a person clicking in the app would: a Reset can't land in the middle
  // of a Complete (the PDF render yields to the event loop) and mix the old data with the new.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function reset() {
    platform = createMemoryPlatform({ seed: seed(now()) });
    store = createMemoryStore();
    files = new Map();
    log = [];
    // Fresh secrets every run, like SSM values only this process knows.
    const secrets = { webhookSecret: randomBytes(24).toString('hex'), linkSecret: randomBytes(32).toString('hex') };
    const quiet = { info() {}, warn() {}, error() {} };
    // The S3 stand-in: the same put/get interface as lib/aws.js createS3Storage.
    const storage = {
      put: (key, bytes) => Promise.resolve(void files.set(key, Buffer.from(bytes))),
      get: (key) => Promise.resolve(files.get(key) ?? null),
    };
    handlers = {
      secrets,
      generateInvoice: createGenerateInvoice({ platform, schema, secrets, store, storage, business: DEMO_BUSINESS, region: 'us-east-1', now, log: quiet }),
      invoicePdf: createInvoicePdf({ secrets, storage, log: quiet }),
      checkSchedule: createCheckSchedule({ platform, schema, secrets, log: quiet }),
    };
    settling = recomputeTotals();
    settling.catch(() => {}); // surfaced through ready(); never an unhandled rejection
    return settling;
  }

  // Tadabase's formula fields on save, as docs/tadabase-setup.md defines them: Line Total =
  // Quantity * Unit Price, and the job's Total = the sum of its Line Totals. Plain numbers, not
  // rounded: a fractional-cent total reaches generate-invoice exactly as it would in production
  // (which then refuses it and sends the job back).
  async function recomputeTotals() {
    const items = (await platform.listAllRecords(T('jobItems'))).map((r) => toLogical(schema, 'jobItems', r));
    const totals = new Map();
    for (const it of items) {
      const lineTotal = formulaNumber(it.quantity) * formulaNumber(it.unitPrice);
      await platform.updateRecord(T('jobItems'), it.id, raw('jobItems', { lineTotal }));
      const jobId = connectionId(it.job);
      totals.set(jobId, (totals.get(jobId) ?? 0) + lineTotal);
    }
    for (const r of await platform.listAllRecords(T('jobs'))) {
      await platform.updateRecord(T('jobs'), r.id, raw('jobs', { total: totals.get(r.id) ?? 0 }));
    }
  }

  const note = (text) => log.unshift({ at: now().toISOString(), text });
  const webhookEvent = (recordId) => ({
    headers: { 'x-fieldflow-secret': handlers.secrets.webhookSecret },
    body: JSON.stringify({ recordId }),
    requestContext: { domainName: DEMO_DOMAIN },
  });
  const context = { getRemainingTimeInMillis: () => 20_000 };
  const jobWritesSince = (from) =>
    platform.calls.slice(from).filter((c) => c.method === 'updateRecord' && c.args[0] === T('jobs')).map((c) => c.args[1]);

  // The Jobs create/update/delete webhook, as Tadabase would fire it: once for the changed jobs,
  // then again for every job the function itself wrote, until nothing changes (at most 5 rounds).
  async function scheduleWebhooks(jobIds) {
    let pending = [...new Set(jobIds)];
    for (let round = 0; round < 5 && pending.length; round += 1) {
      const from = platform.calls.length;
      for (const id of pending) {
        const res = await handlers.checkSchedule(webhookEvent(id), context);
        const body = JSON.parse(res.body);
        if (body.updated) note(`check-schedule (job ${id}): updated ${body.updated} flag(s), ${body.conflicts} job(s) double-booked`);
      }
      pending = [...new Set(jobWritesSince(from))];
    }
  }

  // The job-completed webhook, then the native record rule on Invoices (Status -> Invoiced).
  async function completedWebhook(jobId) {
    const res = await handlers.generateInvoice(webhookEvent(jobId), context);
    const body = JSON.parse(res.body);
    if (res.statusCode === 201) {
      note(`generate-invoice: ${res.statusCode}, invoice ${body.number} for $${body.amount.toFixed(2)}`);
      await platform.updateRecord(T('jobs'), jobId, raw('jobs', { status: 'Invoiced' }));
      note('record rule: invoice created, so the job moves to Invoiced');
    } else if (body.sentBack) {
      note(`generate-invoice: ${res.statusCode}, sent back (${body.error})`);
    } else {
      note(`generate-invoice: ${res.statusCode} ${JSON.stringify(body)}`);
    }
    return { status: res.statusCode, ...body };
  }

  async function getJob(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw httpError(400, 'bad job id');
    const r = await platform.getRecord(T('jobs'), id);
    if (!r) throw httpError(404, 'job not found');
    return toLogical(schema, 'jobs', r);
  }

  // Every change runs alone, and the platform's call log (only needed within one change) is
  // cleared afterwards, so a long demo doesn't keep every signature in memory.
  const change = (fn) => serial(async () => {
    await settling;
    try {
      return await fn();
    } finally {
      platform.calls.length = 0;
    }
  });

  // --- What the page can do (the stand-in for Tadabase's own forms and board) ---

  async function state() {
    await settling;
    const logical = async (table) => (await platform.listAllRecords(T(table))).map((r) => toLogical(schema, table, r));
    const [jobs, items, invoices, customers, technicians] = await Promise.all(
      ['jobs', 'jobItems', 'invoices', 'customers', 'technicians'].map(logical),
    );
    const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? '';
    return {
      jobs: jobs.map((j) => {
        const invoice = invoices.find((i) => connectionId(i.job) === j.id);
        return {
          id: j.id,
          title: j.title,
          status: j.status,
          scheduledDate: j.scheduledDate,
          slot: j.slot,
          customer: nameOf(customers, connectionId(j.customer)),
          technicianId: connectionId(j.technician),
          technician: nameOf(technicians, connectionId(j.technician)),
          total: j.total ?? 0,
          signed: typeof j.signature === 'string' && j.signature !== '',
          invoiceProblem: j.invoiceProblem ?? '',
          scheduleConflict: j.scheduleConflict ?? '',
          items: items.filter((i) => connectionId(i.job) === j.id)
            .map((i) => ({ id: i.id, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, lineTotal: i.lineTotal })),
          invoice: invoice && { number: invoice.number, amount: invoice.amount, issuedDate: invoice.issuedDate, link: invoice.pdfLink },
        };
      }),
      technicians: technicians.map((t) => ({ id: t.id, name: t.name })),
      slots: SLOTS,
      log: log.slice(0, 20),
    };
  }

  // A board drag. Like the real board's guard rails: only between Scheduled and In Progress.
  const move = (id, status) => change(async () => {
    const job = await getJob(id);
    if (!OPEN.includes(status) || !OPEN.includes(job.status)) {
      throw httpError(409, 'Completed and Invoiced are locked on the board: complete a job through its form');
    }
    if (status === job.status) return;
    await platform.updateRecord(T('jobs'), id, raw('jobs', { status }));
    note(`board: job ${id} moved to ${status}`);
    await scheduleWebhooks([id]);
  });

  // An inline edit of the booking (this skips the form's double-booking rule, on purpose).
  const reschedule = (id, { slot, scheduledDate, technicianId }) => change(async () => {
    const job = await getJob(id);
    if (!OPEN.includes(job.status)) throw httpError(409, 'only open jobs can be rescheduled');
    const values = {};
    if (slot !== undefined) {
      if (!SLOTS.includes(slot)) throw httpError(400, 'unknown slot');
      values.slot = slot;
    }
    if (scheduledDate !== undefined) {
      if (typeof scheduledDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) throw httpError(400, 'date must be YYYY-MM-DD');
      values.scheduledDate = scheduledDate;
    }
    if (technicianId !== undefined) {
      if (typeof technicianId !== 'string' || !ID.test(technicianId) || !(await platform.getRecord(T('technicians'), technicianId))) {
        throw httpError(400, 'unknown technician');
      }
      values.technician = [technicianId];
    }
    await platform.updateRecord(T('jobs'), id, raw('jobs', values));
    note(`inline edit: job ${id} rescheduled`);
    await scheduleWebhooks([id]);
  });

  // The Job Items form, with Tadabase's native validation (positive quantity, price 0 or more).
  const addItem = (id, { description, quantity, unitPrice }) => change(async () => {
    const job = await getJob(id);
    if (!OPEN.includes(job.status)) throw httpError(409, 'items can only be added to open jobs');
    const text = String(description ?? '').trim().slice(0, 200);
    if (!text) throw httpError(400, 'description is required');
    let q;
    let p;
    try {
      q = parseQuantityMilli(quantity, 'quantity');
      p = parseMoneyCents(unitPrice, 'unit price');
    } catch (err) {
      throw httpError(400, err.message);
    }
    if (q <= 0 || p < 0) throw httpError(400, 'quantity must be more than 0 and price 0 or more');
    const items = (await platform.listAllRecords(T('jobItems'))).map((r) => toLogical(schema, 'jobItems', r));
    if (items.length >= MAX_ITEMS || items.filter((i) => connectionId(i.job) === id).length >= MAX_ITEMS_PER_JOB) {
      throw httpError(409, 'too many items for this demo; press Reset');
    }
    await platform.createRecord(T('jobItems'), raw('jobItems', { job: [id], description: text, quantity: String(quantity).trim(), unitPrice: String(unitPrice).trim() }));
    await recomputeTotals();
    note(`form: item added to job ${id}`);
  });

  // The Complete job form: Signature is required (native), and the form sets Status to Completed.
  const complete = (id, { signature }) => change(async () => {
    const job = await getJob(id);
    if (!OPEN.includes(job.status)) throw httpError(409, 'only open jobs can be completed');
    if (typeof signature !== 'string' || signature === '') throw httpError(400, 'Signature is required');
    if (signature.length > MAX_SIGNATURE_LENGTH) throw httpError(400, 'Signature is too large');
    await platform.updateRecord(T('jobs'), id, raw('jobs', { signature, status: 'Completed' }));
    note(`form: job ${id} signed and completed`);
    const from = platform.calls.length;
    const result = await completedWebhook(id);
    await scheduleWebhooks([id, ...jobWritesSince(from)]);
    return result;
  });

  const resetNow = () => serial(() => reset());

  async function invoicePdf(file, sig) {
    const res = await handlers.invoicePdf({ pathParameters: { file }, queryStringParameters: sig === undefined ? {} : { sig } }, context);
    return res.isBase64Encoded ? { ...res, bytes: Buffer.from(res.body, 'base64') } : res;
  }

  reset();
  return { reset: resetNow, state, move, reschedule, addItem, complete, invoicePdf, ready: () => settling };
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw httpError(400, 'body must be a JSON object');
  }
}

export function createDemoServer({ demo = createDemo(), host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...(port === 80 ? ['127.0.0.1', 'localhost'] : [])];
      // Only this machine's own names: a web page elsewhere can't reach the demo through DNS tricks.
      if (!hosts.includes(req.headers.host)) throw httpError(403, 'local demo only');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const route = `${req.method} ${url.pathname}`;
      let m;

      if (req.method === 'POST') {
        // Only the demo's own page may change things. Another site open in the browser can send a
        // "simple" POST here (a form, or fetch without CORS): it never has these headers right.
        const origin = req.headers.origin;
        const site = req.headers['sec-fetch-site'];
        if ((origin && !hosts.some((h) => origin === `http://${h}`)) || (site && !['same-origin', 'none'].includes(site))) {
          throw httpError(403, 'requests must come from the demo page');
        }
        if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
          throw httpError(415, 'send JSON (content-type: application/json)');
        }
      }

      if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
        const [file, type] = STATIC[url.pathname];
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- file comes from the fixed STATIC list
        return send(200, await readFile(path.join(root, file)), type);
      }
      if (route === 'GET /api/state') return send(200, await demo.state());
      if (route === 'POST /api/reset') {
        await readJson(req);
        await demo.reset();
        return send(200, await demo.state());
      }
      if (route === 'GET /sample-invoice.pdf') return send(200, Buffer.from(await sampleInvoicePdf()), 'application/pdf');
      if (req.method === 'GET' && (m = /^\/invoices\/([^/]+)$/.exec(url.pathname))) {
        let file;
        try {
          file = decodeURIComponent(m[1]);
        } catch {
          throw httpError(400, 'bad invoice path');
        }
        const out = await demo.invoicePdf(file, url.searchParams.get('sig') ?? undefined);
        return out.bytes ? send(200, out.bytes, 'application/pdf') : send(out.statusCode, JSON.parse(out.body));
      }
      if (req.method === 'POST' && (m = /^\/api\/jobs\/([^/]+)\/(move|reschedule|items|complete)$/.exec(url.pathname))) {
        const [, id, action] = m;
        const body = await readJson(req);
        let result;
        if (action === 'move') await demo.move(id, body.status);
        if (action === 'reschedule') await demo.reschedule(id, body);
        if (action === 'items') await demo.addItem(id, body);
        if (action === 'complete') result = await demo.complete(id, body);
        return send(200, { result, state: await demo.state() });
      }
      throw httpError(404, 'not found');
    } catch (err) {
      // Only the demo's own 4xx errors are shown; anything else is a plain 500, never a crash.
      const status = err?.expose && err.status >= 400 && err.status < 500 ? err.status : 500;
      try {
        if (!res.headersSent) send(status, { error: status === 500 ? 'internal error' : err.message });
        else res.end();
      } catch {
        res.destroy();
      }
    }
  });
  return {
    server,
    listen: (port = 5173) => new Promise((resolve) => server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = createDemoServer();
  app.listen(Number(process.env.PORT) || 5173).then((url) => {
    console.log(`FieldFlow local demo: ${url}`);
    console.log('Real FieldFlow functions, in-memory stand-in for Tadabase. Nothing leaves this machine. Ctrl+C to stop.');
  });
}
