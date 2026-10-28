// One behavior contract, run against both adapters, so tests on the memory adapter mean
// something for the Tadabase one.
import { describe, expect, it } from 'vitest';
import { createMemoryPlatform, createTadabasePlatform } from '../../../lib/platform/index.js';
import { createFakeTadabase } from './fake-tadabase.js';

const JOBS = 'jobs';
const jobs = (n) => Array.from({ length: n }, (_, i) => ({ id: `j${i + 1}`, field_10: `Job ${i + 1}`, field_11: i % 2 ? 'done' : 'open' }));
const SEED = {
  [JOBS]: [
    { id: 'j1', field_10: 'Fix boiler', field_11: 'open' },
    { id: 'j2', field_10: 'Paint fence', field_11: 'done' },
    { id: 'j3', field_10: 'Fix sink', field_11: 'open' },
  ],
  empty: [],
};

const adapters = {
  memory: (seed = SEED) => createMemoryPlatform({ seed }),
  tadabase: (seed = SEED) =>
    createTadabasePlatform({
      appId: 'app',
      appKey: 'key',
      appSecret: 'secret',
      allowLiveWrites: true,
      fetch: createFakeTadabase({ seed }).fetch,
    }),
};

describe.each(Object.entries(adapters))('%s adapter contract', (_, make) => {
  it('gets a record, and null for a missing one', async () => {
    const p = make();
    expect(await p.getRecord(JOBS, 'j1')).toMatchObject({ id: 'j1', field_10: 'Fix boiler' });
    expect(await p.getRecord(JOBS, 'nope')).toBeNull();
  });

  it('lists with filters', async () => {
    const p = make();
    const { items, page, totalPages } = await p.listRecords(JOBS, { filters: [{ field: 'field_11', operator: 'is', value: 'open' }] });
    expect(items.map((r) => r.id).sort()).toEqual(['j1', 'j3']);
    expect({ page, totalPages }).toEqual({ page: 1, totalPages: 1 });
    const contains = await p.listRecords(JOBS, { filters: [{ field: 'field_10', operator: 'contains', value: 'Fix' }] });
    expect(contains.items).toHaveLength(2);
    const not = await p.listRecords(JOBS, { filters: [{ field: 'field_11', operator: 'is not', value: 'open' }] });
    expect(not.items.map((r) => r.id)).toEqual(['j2']);
  });

  it('pages results', async () => {
    const p = make();
    const first = await p.listRecords(JOBS, { page: 1, limit: 2 });
    const second = await p.listRecords(JOBS, { page: 2, limit: 2 });
    expect(first.totalPages).toBe(2);
    expect([...first.items, ...second.items].map((r) => r.id).sort()).toEqual(['j1', 'j2', 'j3']);
  });

  it('caps the page size at 100', async () => {
    const p = make({ [JOBS]: jobs(150) });
    const { items, totalPages } = await p.listRecords(JOBS, { limit: 500 });
    expect(items).toHaveLength(100);
    expect(totalPages).toBe(2);
  });

  it('lists all records across pages', async () => {
    const p = make({ [JOBS]: jobs(250) });
    expect(await p.listAllRecords(JOBS)).toHaveLength(250);
  });

  it('stops listAllRecords at maxPages', async () => {
    const p = make({ [JOBS]: jobs(250) });
    await expect(p.listAllRecords(JOBS, { maxPages: 2 })).rejects.toThrow(/more than 2 pages/);
  });

  it('creates, updates and deletes', async () => {
    const p = make();
    const { id } = await p.createRecord(JOBS, { field_10: 'New job', field_11: 'open' });
    expect(typeof id).toBe('string');
    expect(await p.getRecord(JOBS, id)).toMatchObject({ field_10: 'New job' });
    await p.updateRecord(JOBS, id, { field_11: 'done' });
    expect(await p.getRecord(JOBS, id)).toMatchObject({ field_10: 'New job', field_11: 'done' });
    await p.deleteRecord(JOBS, id);
    expect(await p.getRecord(JOBS, id)).toBeNull();
  });

  it('rejects updating or deleting a missing record with a 404 platform error', async () => {
    const p = make();
    await expect(p.updateRecord(JOBS, 'nope', { field_11: 'x' })).rejects.toMatchObject({ name: 'PlatformError', status: 404 });
    await expect(p.deleteRecord(JOBS, 'nope')).rejects.toMatchObject({ name: 'PlatformError', status: 404 });
  });

  it('rejects an unknown table instead of treating it as empty', async () => {
    const p = make();
    await expect(p.listRecords('jbos')).rejects.toMatchObject({ name: 'PlatformError', status: 404 });
    await expect(p.createRecord('jbos', {})).rejects.toMatchObject({ name: 'PlatformError', status: 404 });
  });

  it.each(['', '.', '..', 'a b', 'x/y', undefined, 7])('rejects the id %j before using it', async (bad) => {
    const p = make();
    await expect(p.getRecord(JOBS, bad)).rejects.toThrow(/invalid record id/);
    await expect(p.updateRecord(JOBS, bad, {})).rejects.toThrow(/invalid record id/);
    await expect(p.deleteRecord(JOBS, bad)).rejects.toThrow(/invalid record id/);
    await expect(p.listRecords(bad)).rejects.toThrow(/invalid table id/);
  });

  it('rejects unknown filter operators, even on an empty table', async () => {
    await expect(make().listRecords('empty', { filters: [{ field: 'f', operator: 'like', value: 'x' }] })).rejects.toThrow(/operator/);
  });
});
