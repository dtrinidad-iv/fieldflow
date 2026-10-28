import { describe, expect, it, vi } from 'vitest';
import { createTadabasePlatform, LiveWritesDisabledError } from '../../../lib/platform/tadabase.js';
import { createFakeTadabase } from './fake-tadabase.js';

const creds = { appId: 'app-id', appKey: 'app-key', appSecret: 'app-secret' };
const make = (options = {}) => {
  const fake = createFakeTadabase({ seed: { jobs: [{ id: 'j1', field_10: 'Fix boiler' }] } });
  return { fake, p: createTadabasePlatform({ ...creds, fetch: fake.fetch, ...options }) };
};
const respond = (status, body) =>
  vi.fn(() => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(new Response(status === 204 ? null : text, { status }));
  });

describe('tadabase adapter', () => {
  it('requires credentials', () => {
    expect(() => createTadabasePlatform({ appId: 'a', appKey: '', appSecret: 's' })).toThrow(/required/);
  });

  it('sends the three auth headers to the record URL, and refuses redirects', async () => {
    const fetch = respond(200, { type: 'success', item: { id: 'DVWQ_49' } });
    await createTadabasePlatform({ ...creds, fetch }).getRecord('lGArg7rmR6', 'DVWQ_49');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.tadabase.io/api/v1/data-tables/lGArg7rmR6/records/DVWQ_49');
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { 'X-Tadabase-App-id': 'app-id', 'X-Tadabase-App-Key': 'app-key', 'X-Tadabase-App-Secret': 'app-secret' },
    });
  });

  it('sends filters, page and a capped limit as query parameters', async () => {
    const { fake, p } = make();
    await p.listRecords('jobs', { filters: [{ field: 'field_11', operator: 'is', value: 'open' }], page: 2, limit: 500 });
    const params = new URL(fake.requests[0].url).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      page: '2',
      limit: '100',
      'filters[items][0][field_id]': 'field_11',
      'filters[items][0][operator]': 'is',
      'filters[items][0][val]': 'open',
    });
  });

  it('sends updates as a JSON POST to the record URL', async () => {
    const { fake, p } = make({ allowLiveWrites: true });
    await p.updateRecord('jobs', 'j1', { field_10: 'Fix heater' });
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.tadabase.io/api/v1/data-tables/jobs/records/j1',
      body: { field_10: 'Fix heater' },
    });
    expect(fake.requests[0].headers['content-type']).toBe('application/json');
  });

  it('accepts an empty answer to an update or delete', async () => {
    const p = createTadabasePlatform({ ...creds, allowLiveWrites: true, fetch: respond(204, '') });
    await expect(p.updateRecord('jobs', 'j1', { a: 1 })).resolves.toBeUndefined();
    await expect(p.deleteRecord('jobs', 'j1')).resolves.toBeUndefined();
  });

  describe('live write guard', () => {
    it.each([
      ['createRecord', (p) => p.createRecord('jobs', { field_10: 'x' })],
      ['updateRecord', (p) => p.updateRecord('jobs', 'j1', { field_10: 'x' })],
      ['deleteRecord', (p) => p.deleteRecord('jobs', 'j1')],
    ])('%s throws before any request unless live writes are allowed', async (_, write) => {
      const { fake, p } = make();
      await expect(write(p)).rejects.toBeInstanceOf(LiveWritesDisabledError);
      expect(fake.requests).toEqual([]);
    });

    it.each(['1', 'true', 'false', '0', 1])('treats %j as off: only the boolean true allows writes', async (value) => {
      const { fake, p } = make({ allowLiveWrites: value });
      await expect(p.createRecord('jobs', {})).rejects.toBeInstanceOf(LiveWritesDisabledError);
      expect(fake.requests).toEqual([]);
    });

    it('still allows reads', async () => {
      const { p } = make();
      expect(await p.getRecord('jobs', 'j1')).toMatchObject({ id: 'j1' });
    });
  });

  describe('upstream failures', () => {
    it('passes a timeout signal and aborts a slow request', async () => {
      const slow = vi.fn((url, init) => new Promise((_, reject) => {
        if (!(init.signal instanceof AbortSignal)) throw new Error('no timeout signal passed to fetch');
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }));
      const p = createTadabasePlatform({ ...creds, fetch: slow, timeoutMs: 20 });
      await expect(p.getRecord('jobs', 'j1')).rejects.toMatchObject({ name: 'PlatformError', status: 0 });
      const { signal } = slow.mock.calls[0][1];
      expect(signal.aborted).toBe(true);
      expect(signal.reason.name).toBe('TimeoutError');
    });

    it('maps a refused redirect to a PlatformError', async () => {
      const redirecting = vi.fn(() => Promise.reject(new TypeError('fetch failed: unexpected redirect')));
      const p = createTadabasePlatform({ ...creds, fetch: redirecting });
      await expect(p.getRecord('jobs', 'j1')).rejects.toMatchObject({ name: 'PlatformError', status: 0 });
    });

    it('maps a 5xx to a PlatformError without the upstream body', async () => {
      const p = createTadabasePlatform({ ...creds, fetch: respond(500, { msg: 'internal detail: db host 10.0.0.5' }) });
      const err = await p.listRecords('jobs').catch((e) => e);
      expect(err).toMatchObject({ name: 'PlatformError', status: 500, operation: 'listRecords' });
      expect(JSON.stringify(err) + err.message).not.toContain('10.0.0.5');
    });

    it('treats a 200 with type "error" as a failure', async () => {
      const p = createTadabasePlatform({ ...creds, fetch: respond(200, { type: 'error', msg: 'Invalid API key' }) });
      await expect(p.getRecord('jobs', 'j1')).rejects.toMatchObject({ name: 'PlatformError', status: 200 });
    });

    it('treats a non-JSON answer as a failure', async () => {
      const p = createTadabasePlatform({ ...creds, fetch: respond(200, '<html>maintenance</html>') });
      await expect(p.getRecord('jobs', 'j1')).rejects.toMatchObject({ name: 'PlatformError' });
    });

    // An unexpected shape must fail loudly: read as "no records", it would let an idempotency
    // check create a duplicate.
    it.each([
      ['a list without items', (p) => p.listRecords('jobs'), { type: 'success', data: [] }],
      ['a get without item', (p) => p.getRecord('jobs', 'j1'), { type: 'success' }],
      ['an empty list answer', (p) => p.listRecords('jobs'), ''],
    ])('treats %s as a failure, not an empty result', async (_, call, body) => {
      const p = createTadabasePlatform({ ...creds, fetch: respond(200, body) });
      await expect(call(p)).rejects.toMatchObject({ name: 'PlatformError' });
    });

    it('fails a create that returns no record id', async () => {
      const p = createTadabasePlatform({ ...creds, allowLiveWrites: true, fetch: respond(200, { type: 'success' }) });
      await expect(p.createRecord('jobs', {})).rejects.toMatchObject({ name: 'PlatformError', operation: 'createRecord' });
    });
  });

  it('stops listAllRecords at maxPages instead of looping forever', async () => {
    const endless = respond(200, { type: 'success', items: [{ id: 'x' }], total_pages: 1000, current_page: 1 });
    const p = createTadabasePlatform({ ...creds, fetch: endless });
    await expect(p.listAllRecords('jobs', { maxPages: 3 })).rejects.toThrow(/more than 3 pages/);
    expect(endless).toHaveBeenCalledTimes(3);
  });

  it('uses the real fetch by default, which the test setup blocks', async () => {
    const p = createTadabasePlatform(creds);
    await expect(p.getRecord('jobs', 'j1')).rejects.toMatchObject({ name: 'PlatformError', status: 0 });
  });
});
