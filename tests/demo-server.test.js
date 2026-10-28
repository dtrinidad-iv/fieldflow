// The local client demo (plan 09) runs the real functions in memory, on 127.0.0.1 only.
// tests/setup.js allows connections to localhost, so these tests talk to a real server.
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDemoServer } from '../scripts/demo-server.js';

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';
let app;
let base;

beforeAll(async () => {
  app = createDemoServer();
  base = await app.listen(0);
});
afterAll(() => app.close());
beforeEach(() => post('/api/reset', {}));

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}
async function post(path, body, raw) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const job = (state, id) => state.jobs.find((j) => j.id === id);
// fetch drops a custom Host header, so this check uses node:http directly.
const statusWithHost = (host) => new Promise((resolve, reject) => {
  const { port } = new URL(base);
  http.get({ hostname: '127.0.0.1', port, path: '/', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

describe('demo server', () => {
  it('listens on 127.0.0.1 only, and refuses any other Host header', async () => {
    expect(app.server.address().address).toBe('127.0.0.1');
    expect(await statusWithHost('evil.test')).toBe(403);
    expect(await statusWithHost(`localhost:${new URL(base).port}`)).toBe(200);
  });

  it('serves the page and the widgets, and nothing outside its fixed list', async () => {
    expect((await get('/')).type).toMatch(/text\/html/);
    expect((await get('/widgets/signature-pad.js')).status).toBe(200);
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/package.json', '/.env', '/demo/app.html', '/scripts/demo-server.js']) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('serves a sample invoice PDF', async () => {
    const pdf = await get('/sample-invoice.pdf');
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('completing a signed job with items creates the real invoice, moves it to Invoiced, and serves the PDF', async () => {
    const { status, body } = await post('/api/jobs/job1/complete', { signature: SIGNATURE });
    expect(status).toBe(200);
    expect(body.result).toMatchObject({ status: 201, number: 'INV-job1', amount: 849 });
    const done = job(body.state, 'job1');
    expect(done.status).toBe('Invoiced');
    expect(done.invoice).toMatchObject({ number: 'INV-job1', amount: 849 });

    const link = new URL(done.invoice.link);
    expect(link.hostname).toBe('demo.execute-api.us-east-1.amazonaws.com'); // what generate-invoice requires
    const pdf = await get(link.pathname + link.search);
    expect(pdf.type).toBe('application/pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');

    const forged = `${link.pathname}?sig=${'A'.repeat(43)}`;
    expect((await get(forged)).status).toBe(403); // the real invoice-pdf handler checks the signature
    expect(body.state.log.map((l) => l.text).join('\n')).toMatch(/generate-invoice: 201/);
  });

  it('completing a job with no items sends it back with the reason, and creates no invoice', async () => {
    const { body } = await post('/api/jobs/job3/complete', { signature: SIGNATURE });
    expect(body.result).toMatchObject({ status: 422, sentBack: true, error: 'job has no line items' });
    const back = job(body.state, 'job3');
    expect(back.status).toBe('In Progress');
    expect(back.invoiceProblem).toMatch(/^Not invoiced: job has no line items/);
    expect(back.invoice).toBeUndefined();
  });

  it('refuses to complete without a signature (the form rule)', async () => {
    expect((await post('/api/jobs/job4/complete', { signature: '' })).status).toBe(400);
  });

  it('flags a double booking on both jobs, and clears both when one moves', async () => {
    // job1 is Alex's Morning slot tomorrow; job3 is Alex's Afternoon slot the same day.
    let { body } = await post('/api/jobs/job3/reschedule', { slot: 'Morning' });
    expect(job(body.state, 'job1').scheduleConflict).toBe('Double-booked with: job3');
    expect(job(body.state, 'job3').scheduleConflict).toBe('Double-booked with: job1');
    ({ body } = await post('/api/jobs/job3/reschedule', { slot: 'Evening' }));
    expect(job(body.state, 'job1').scheduleConflict).toBe('');
    expect(job(body.state, 'job3').scheduleConflict).toBe('');
  });

  it('keeps Completed and Invoiced locked on the board, like the real guard rails', async () => {
    expect((await post('/api/jobs/job1/move', { status: 'Completed' })).status).toBe(409);
    expect((await post('/api/jobs/job1/move', { status: 'In Progress' })).status).toBe(200);
    await post('/api/jobs/job1/complete', { signature: SIGNATURE });
    expect((await post('/api/jobs/job1/move', { status: 'Scheduled' })).status).toBe(409);
  });

  it('adds an item with the invoice rules, and updates the totals like the formula fields', async () => {
    expect((await post('/api/jobs/job4/items', { description: 'Wiring', quantity: '1', unitPrice: '1.234,50' })).status).toBe(400);
    const { body } = await post('/api/jobs/job4/items', { description: 'Wiring', quantity: '1.5', unitPrice: '$40.00' });
    const updated = job(body.state, 'job4');
    expect(updated.items.at(-1)).toMatchObject({ description: 'Wiring', lineTotal: 60 });
    expect(updated.total).toBe(249);
  });

  it('answers bad requests with clear errors', async () => {
    expect((await post('/api/jobs/job1/move', null, '{not json')).status).toBe(400);
    expect((await post('/api/jobs/nope/move', { status: 'Scheduled' })).status).toBe(404);
    expect((await post('/api/jobs/..%2F..%2Fetc/move', { status: 'Scheduled' })).status).toBe(400);
    expect((await post('/api/jobs/job1/reschedule', { slot: 'Midnight' })).status).toBe(400);
    expect((await post('/api/jobs/job1/complete', { signature: 'x'.repeat(300 * 1024) })).status).toBe(413);
    expect((await get('/api/nothing')).status).toBe(404);
  });

  it('refuses POSTs another site could send: not JSON (415), a foreign Origin or a cross-site fetch (403)', async () => {
    const raw = (headers, body = '{"status":"In Progress"}') => new Promise((resolve, reject) => {
      const { port } = new URL(base);
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/jobs/job1/move', method: 'POST', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(body);
    });
    const host = new URL(base).host;
    expect(await raw({ host, 'content-type': 'text/plain' })).toBe(415);
    expect(await raw({ host, 'content-type': 'application/x-www-form-urlencoded' })).toBe(415);
    expect(await raw({ host, 'content-type': 'application/json', origin: 'https://evil.test' })).toBe(403);
    expect(await raw({ host, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).toBe(403);
    expect(await raw({ host, 'content-type': 'application/json', origin: `http://${host}`, 'sec-fetch-site': 'same-origin' })).toBe(200);
    // None of the refused ones changed anything.
    const { body } = await post('/api/reset', {});
    expect(job(body, 'job1').status).toBe('Scheduled');
  });

  it('a total with a fraction of a cent reaches the real invoice check, which sends the job back', async () => {
    // The formula fields aren't rounded (Quantity * Unit Price), as in Tadabase: 1.5 x $0.33 = 0.495.
    await post('/api/jobs/job4/items', { description: 'Washers', quantity: '1.5', unitPrice: '0.33' });
    const { body } = await post('/api/jobs/job4/complete', { signature: SIGNATURE });
    expect(body.result).toMatchObject({ status: 422, sentBack: true });
    expect(body.result.error).toMatch(/job total/);
    expect(job(body.state, 'job4').status).toBe('In Progress');
  });

  it('a sent-back job, once fixed and completed again, is invoiced and its problem cleared', async () => {
    await post('/api/jobs/job3/complete', { signature: SIGNATURE });
    await post('/api/jobs/job3/items', { description: 'Washer and labour', quantity: '1', unitPrice: '$60.00' });
    const { body } = await post('/api/jobs/job3/complete', { signature: SIGNATURE });
    expect(body.result).toMatchObject({ status: 201, number: 'INV-job3', amount: 60 });
    expect(job(body.state, 'job3')).toMatchObject({ status: 'Invoiced', invoiceProblem: '' });
  });

  it('caps items per job, and refuses an oversized signature before storing it', async () => {
    for (let i = 0; i < 49; i += 1) await post('/api/jobs/job4/items', { description: `Part ${i}`, quantity: '1', unitPrice: '1' });
    expect((await post('/api/jobs/job4/items', { description: 'One too many', quantity: '1', unitPrice: '1' })).status).toBe(409);
    const tooBig = `data:image/png;base64,${'A'.repeat(100_000)}`;
    expect((await post('/api/jobs/job1/complete', { signature: tooBig })).status).toBe(400);
  });

  it('answers 400, not 500, for a malformed path or a non-string technician', async () => {
    expect((await get('/invoices/%E0.pdf')).status).toBe(400);
    expect((await post('/api/jobs/job1/reschedule', { technicianId: ['tech1'] })).status).toBe(400);
    expect((await post('/api/jobs/job1/reschedule', { technicianId: '../x' })).status).toBe(400);
  });

  it('runs one change at a time: a Reset during a Complete never mixes old and new data', async () => {
    const completing = post('/api/jobs/job1/complete', { signature: SIGNATURE });
    const resetting = post('/api/reset', {});
    await Promise.all([completing, resetting]);
    const state = (await (await fetch(`${base}/api/state`)).json());
    const j1 = job(state, 'job1');
    // Whichever arrived first, the result is one of the two consistent states, never "Invoiced
    // with no invoice" (the Complete's record rule landing on the fresh seed).
    if (j1.status === 'Invoiced') expect(j1.invoice?.number).toBe('INV-job1');
    else expect([j1.status, j1.invoice]).toEqual(['Scheduled', undefined]);
  });

  it('reset clears flags and the activity log', async () => {
    await post('/api/jobs/job3/reschedule', { slot: 'Morning' });
    const { body } = await post('/api/reset', {});
    expect(body.jobs.every((j) => j.scheduleConflict === '')).toBe(true);
    expect(body.log).toEqual([]);
  });

  it('reset restores the seed data', async () => {
    await post('/api/jobs/job1/complete', { signature: SIGNATURE });
    const { body } = await post('/api/reset', {});
    expect(job(body, 'job1').status).toBe('Scheduled');
    expect(body.jobs.every((j) => !j.invoice)).toBe(true);
  });
});
