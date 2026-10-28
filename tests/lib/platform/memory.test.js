import { describe, expect, it } from 'vitest';
import { PlatformError } from '../../../lib/errors.js';
import { createMemoryPlatform } from '../../../lib/platform/memory.js';

describe('memory adapter', () => {
  it('copies seed data, so tests can not mutate each other', async () => {
    const seed = { jobs: [{ id: 'j1', title: 'a' }] };
    const p = createMemoryPlatform({ seed });
    (await p.getRecord('jobs', 'j1')).title = 'changed';
    expect((await p.getRecord('jobs', 'j1')).title).toBe('a');
    expect(seed.jobs[0].title).toBe('a');
  });

  it('knows seeded tables and the empty tables it was given, nothing else', async () => {
    const p = createMemoryPlatform({ seed: { jobs: [] }, tables: ['invoices'] });
    await expect(p.listRecords('jobs')).resolves.toMatchObject({ items: [] });
    await expect(p.listRecords('invoices')).resolves.toMatchObject({ items: [] });
    await expect(p.listRecords('contacts')).rejects.toMatchObject({ status: 404 });
  });

  it('records every call for side-effect assertions', async () => {
    const p = createMemoryPlatform({ tables: ['jobs'] });
    await p.createRecord('jobs', { title: 'x' });
    await p.getRecord('jobs', 'mem1');
    expect(p.calls.map((c) => c.method)).toEqual(['createRecord', 'getRecord']);
    expect(p.calls[0].args).toEqual(['jobs', { title: 'x' }]);
  });

  it('failNext makes exactly the next call to that method reject', async () => {
    const p = createMemoryPlatform({ tables: ['jobs'] });
    p.failNext('createRecord');
    await expect(p.createRecord('jobs', {})).rejects.toBeInstanceOf(PlatformError);
    await expect(p.createRecord('jobs', {})).resolves.toEqual({ id: 'mem1' });
  });

  it('failNext can inject a specific error', async () => {
    const p = createMemoryPlatform({ tables: ['jobs'] });
    const err = new PlatformError(429, 'listRecords');
    p.failNext('listRecords', err);
    await expect(p.listRecords('jobs')).rejects.toBe(err);
  });
});
