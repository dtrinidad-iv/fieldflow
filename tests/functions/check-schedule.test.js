import { describe, expect, it, vi } from 'vitest';
import { createHandler, MAX_GROUP, MAX_TECHNICIANS, MIN_MS_LEFT } from '../../functions/check-schedule/handler.js';
import { createMemoryPlatform } from '../../lib/platform/memory.js';
import { REQUIRED_FIELDS } from '../../lib/schema.js';

const schema = {
  tables: Object.fromEntries(
    Object.entries(REQUIRED_FIELDS).map(([t, f]) => [t, { id: `T_${t}`, fields: Object.fromEntries(Object.keys(f).map((n, i) => [n, `field_${i + 1}`])) }]),
  ),
};
const F = (name) => schema.tables.jobs.fields[name];
const SECRET = 'test-webhook-secret';

// A raw job record. Defaults: Morning of 2026-11-02, technician tech1, Scheduled.
const job = (id, { technician = 'tech1', date = '2026-11-02', slot = 'Morning', status = 'Scheduled', conflict } = {}) => ({
  id,
  [F('technician')]: [technician],
  [F('scheduledDate')]: date,
  [F('slot')]: slot,
  [F('status')]: status,
  ...(conflict === undefined ? {} : { [F('scheduleConflict')]: conflict }),
});

function setup(jobs) {
  const platform = createMemoryPlatform({ seed: { T_jobs: jobs } });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handler = createHandler({ platform, schema, secrets: { webhookSecret: SECRET }, log });
  const call = async (recordId = 'a', secret = SECRET) => {
    const res = await handler({ headers: secret ? { 'x-fieldflow-secret': secret } : {}, body: JSON.stringify({ recordId }) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const flag = async (id) => (await platform.getRecord('T_jobs', id))?.[F('scheduleConflict')] ?? '';
  const writes = () => platform.calls.filter((c) => c.method === 'updateRecord');
  return { platform, log, call, flag, writes };
}

describe('check-schedule', () => {
  it('rejects a missing or wrong secret with 401, writing nothing', async () => {
    const { call, writes } = setup([job('a'), job('b')]);
    expect((await call('a', null)).status).toBe(401);
    expect((await call('a', 'wrong')).status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it('rejects a bad record id with 400', async () => {
    const { call } = setup([]);
    expect((await call('../x')).status).toBe(400);
  });

  it('flags both jobs of a double booking', async () => {
    const { call, flag } = setup([job('a'), job('b')]);
    expect(await call('a')).toEqual({ status: 200, body: { checked: 2, updated: 2, conflicts: 2 } });
    expect(await flag('a')).toBe('Double-booked with: b');
    expect(await flag('b')).toBe('Double-booked with: a');
  });

  it('writes nothing when there is no conflict', async () => {
    const { call, writes } = setup([job('a'), job('b', { slot: 'Afternoon' }), job('c', { date: '2026-11-03' }), job('d', { technician: 'tech2' })]);
    expect((await call('a')).body).toEqual({ checked: 1, updated: 0, conflicts: 0 });
    expect(writes()).toHaveLength(0);
  });

  it('does not count Completed or Invoiced jobs as booked', async () => {
    const { call, writes } = setup([job('a'), job('b', { status: 'Completed' }), job('c', { status: 'Invoiced' })]);
    expect((await call('a')).body.conflicts).toBe(0);
    expect(writes()).toHaveLength(0);
  });

  it('writes nothing the second time: its own update webhook stops there (loop guard)', async () => {
    const { call, writes } = setup([job('a'), job('b')]);
    await call('a');
    const after = writes().length;
    expect((await call('a')).body.updated).toBe(0);
    expect((await call('b')).body.updated).toBe(0);
    expect(writes()).toHaveLength(after);
  });

  it('clears the old partner when a job moves to another slot', async () => {
    const { platform, call, flag } = setup([job('a'), job('b')]);
    await call('a');
    await platform.updateRecord('T_jobs', 'a', { [F('slot')]: 'Evening' });
    await call('a'); // the move's webhook
    expect(await flag('a')).toBe('');
    expect(await flag('b')).toBe('');
  });

  it('clears the partners of a deleted job', async () => {
    const { platform, call, flag } = setup([job('a'), job('b'), job('c')]);
    await call('a');
    expect(await flag('b')).toBe('Double-booked with: a, c');
    await platform.deleteRecord('T_jobs', 'a');
    expect((await call('a')).status).toBe(200);
    expect(await flag('b')).toBe('Double-booked with: c');
    expect(await flag('c')).toBe('Double-booked with: b');
  });

  it('clears the flag of a job that is completed', async () => {
    const { platform, call, flag } = setup([job('a'), job('b')]);
    await call('a');
    await platform.updateRecord('T_jobs', 'a', { [F('status')]: 'Completed' });
    await call('a');
    expect(await flag('a')).toBe('');
    expect(await flag('b')).toBe('');
  });

  it('a false "contains" match (job4 in job40) only costs a re-check, which computes the right flag', async () => {
    const { call, flag } = setup([
      job('job4', { slot: 'Evening' }),
      job('job42', { conflict: 'Double-booked with: job40' }), // job40 is still its real partner
      job('job40'),
    ]);
    expect((await call('job4')).body.checked).toBe(2); // job4, plus job42 through the substring match
    expect(await flag('job42')).toBe('Double-booked with: job40');
  });

  it('leaves alone a job whose flag does not mention this one', async () => {
    const { call, flag } = setup([job('a', { slot: 'Evening' }), job('b', { conflict: 'Double-booked with: z' })]);
    await call('a');
    expect(await flag('b')).toBe('Double-booked with: z');
  });

  it('clears the old partner when a job moves to another technician', async () => {
    const { platform, call, flag } = setup([job('a'), job('b')]);
    await call('a');
    await platform.updateRecord('T_jobs', 'a', { [F('technician')]: ['tech2'] });
    await call('a');
    expect(await flag('a')).toBe('');
    expect(await flag('b')).toBe('');
  });

  it('a write failing partway answers an error, and the next delivery finishes the rest', async () => {
    const { platform, call, flag } = setup([job('a'), job('b'), job('c')]);
    const real = platform.updateRecord;
    let n = 0;
    platform.updateRecord = (...args) => (++n === 2 ? Promise.reject(new Error('timeout')) : real(...args));
    expect((await call('a')).status).toBe(500);
    platform.updateRecord = real;
    expect((await call('a')).status).toBe(200);
    expect([await flag('a'), await flag('b'), await flag('c')]).toEqual([
      'Double-booked with: b, c', 'Double-booked with: a, c', 'Double-booked with: a, b',
    ]);
  });

  it('stops with 503 before running out of time, and a retry completes it', async () => {
    const { platform, call, flag } = setup([job('a'), job('b')]);
    const handler = createHandler({ platform, schema, secrets: { webhookSecret: SECRET }, log: { info() {}, warn: vi.fn(), error() {} } });
    const res = await handler(
      { headers: { 'x-fieldflow-secret': SECRET }, body: JSON.stringify({ recordId: 'a' }) },
      { getRemainingTimeInMillis: () => MIN_MS_LEFT - 1 },
    );
    expect(res.statusCode).toBe(503);
    expect(platform.calls.filter((c) => c.method === 'updateRecord')).toHaveLength(0);
    await call('a');
    expect(await flag('a')).toBe('Double-booked with: b');
  });

  it(`reads at most ${MAX_TECHNICIANS} technicians' jobs per run, skipping (and logging) the rest`, async () => {
    // Job "x" was double-booked with jobs on many other technicians' days (stale flags naming it).
    const stale = Array.from({ length: MAX_TECHNICIANS + 2 }, (_, i) => job(`s${i}`, { technician: `t${i}`, conflict: 'Double-booked with: x' }));
    const { call, log } = setup([job('x', { slot: 'Evening' }), ...stale]);
    const { body } = await call('x');
    expect(body.skipped).toBe(3); // x's own technician counts too
    expect(log.warn).toHaveBeenCalledWith('schedule check skipped jobs: too many technicians', { jobId: 'x', skipped: 3 });
  });

  it('answers 502 on a platform failure', async () => {
    const { platform, call } = setup([job('a'), job('b')]);
    platform.failNext('listRecords');
    expect((await call('a')).status).toBe(502);
  });

  it(`re-checks at most ${MAX_GROUP} jobs, and logs when it had to stop`, async () => {
    const many = Array.from({ length: MAX_GROUP + 5 }, (_, i) => job(`j${i}`));
    const { call, log } = setup(many);
    expect((await call('j0')).body.checked).toBe(MAX_GROUP);
    expect(log.warn).toHaveBeenCalledWith('schedule check group truncated', { jobId: 'j0', size: MAX_GROUP + 5 });
  });
});
