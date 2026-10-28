// POST /webhooks/job-schedule: Tadabase calls this when a job is created, updated or deleted
// (webhook body: {"recordId": "{record_id}"}). It flags double-booked jobs (same technician, date
// and slot; see lib/schedule.js) in their Schedule Conflict field, and clears flags that no longer
// apply. Forms block most double bookings natively; this catches the rest (inline
// edits, imports, the API). It can't block a save, only flag it.
//
// Idempotent by construction, so no idempotency claim: every flag is computed from the current
// data and written only when it would change. A repeated delivery, or the update webhook fired by
// its own write, finds nothing to change and stops: that's also the loop guard.
import { HttpError } from '../../lib/errors.js';
import { parseJsonBody, wrap } from '../../lib/http.js';
import { createLogger } from '../../lib/log.js';
import { connectionId } from '../../lib/invoice.js';
import { getRuntime } from '../../lib/runtime.js';
import { conflictText, bookingKey } from '../../lib/schedule.js';
import { fieldsOf, tableId, toLogical, toSlugs } from '../../lib/schema.js';
import { requireId } from '../../lib/validate.js';
import { verifySecret } from '../../lib/webhook.js';

// Bounds per delivery, so one run's Tadabase traffic stays small and fits the timeout: at most
// this many jobs re-checked, this many technicians' job lists read, and never closer to the
// Lambda timeout than MIN_MS_LEFT. A run cut short answers 503; the rest is recomputed by the
// next delivery (every write is recomputed state, so a partial run is harmless).
export const MAX_GROUP = 25;
export const MAX_TECHNICIANS = 5;
export const MIN_MS_LEFT = 6000;
export const SECRET_KEYS = ['appId', 'appKey', 'appSecret', 'webhookSecret'];
const resolve = (dep) => (typeof dep === 'function' ? dep() : dep);

async function recheck({ jobId, platform, schema, remainingMs, log }) {
  const jobs = tableId(schema, 'jobs');
  const fields = fieldsOf(schema, 'jobs');
  const logical = (rows) => rows.map((r) => toLogical(schema, 'jobs', r));
  const checkTime = () => {
    if (remainingMs() < MIN_MS_LEFT) {
      log.warn('schedule check stopped: not enough time left', { jobId });
      throw new HttpError(503, 'schedule check ran out of time; retry');
    }
  };

  // A technician's open jobs, the only ones that hold a booking. Status and technician are
  // filtered by the API, and the technician checked again here; dates are compared in code.
  const openByTechnician = new Map();
  async function openJobsOf(technicianId) {
    if (!openByTechnician.has(technicianId)) {
      if (openByTechnician.size >= MAX_TECHNICIANS) return null; // not read this run
      checkTime();
      const rows = await platform.listAllRecords(jobs, {
        filters: [
          { field: fields.technician, operator: 'is', value: technicianId },
          { field: fields.status, operator: 'is not', value: 'Completed' },
          { field: fields.status, operator: 'is not', value: 'Invoiced' },
        ],
      });
      openByTechnician.set(technicianId, logical(rows).filter((j) => connectionId(j.technician) === technicianId));
    }
    return openByTechnician.get(technicianId);
  }

  const raw = await platform.getRecord(jobs, jobId);
  let job = raw ? toLogical(schema, 'jobs', raw) : null;

  // Which flags may need to change: the job's own, the jobs that share its booking now, and the
  // jobs whose flag names it (it may have moved, or been deleted). A false "contains" match
  // (job4 in job42) only costs a re-check.
  const group = new Map();
  checkTime();
  const naming = logical(await platform.listAllRecords(jobs, { filters: [{ field: fields.scheduleConflict, operator: 'contains', value: jobId }] }));
  for (const other of naming) group.set(other.id, other);
  const technicianId = job && connectionId(job.technician);
  if (technicianId && bookingKey(job)) {
    const open = await openJobsOf(technicianId);
    // Compare the job in the same shape as the jobs it's compared with (a list row, not a get).
    job = open.find((j) => j.id === job.id) ?? job;
    for (const other of open) if (bookingKey(other) === bookingKey(job)) group.set(other.id, other);
  }
  if (job) group.set(job.id, job);

  let members = [...group.values()];
  if (members.length > MAX_GROUP) {
    log.warn('schedule check group truncated', { jobId, size: members.length });
    members = members.slice(0, MAX_GROUP);
  }

  let updated = 0;
  let conflicts = 0;
  let skipped = 0;
  for (const member of members) {
    const memberTechnician = connectionId(member.technician);
    let expected = '';
    if (bookingKey(member) && memberTechnician) {
      const others = await openJobsOf(memberTechnician);
      if (!others) {
        skipped += 1; // too many technicians this run; its own next update re-checks it
        continue;
      }
      expected = conflictText(member, others);
    }
    if (expected) conflicts += 1;
    const current = typeof member.scheduleConflict === 'string' ? member.scheduleConflict.trim() : '';
    if (current === expected) continue;
    checkTime();
    await platform.updateRecord(jobs, member.id, toSlugs(schema, 'jobs', { scheduleConflict: expected }));
    updated += 1;
  }
  if (skipped) log.warn('schedule check skipped jobs: too many technicians', { jobId, skipped });
  if (updated) log.info('schedule flags updated', { jobId, updated, conflicts });
  return { status: 200, body: { checked: members.length - skipped, updated, conflicts, ...(skipped ? { skipped } : {}) } };
}

export function createHandler({ platform, schema, secrets, log = createLogger({ fn: 'check-schedule' }) }) {
  return wrap(async (event, context) => {
    const { webhookSecret } = await resolve(secrets);
    verifySecret(event, webhookSecret, log);
    const jobId = requireId(parseJsonBody(event), 'recordId');
    const remainingMs = () => (typeof context?.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : Infinity);
    return recheck({ jobId, platform: await resolve(platform), schema: await resolve(schema), remainingMs, log });
  }, { log });
}

// Deployed: built lazily inside the request, so a setup problem becomes a logged 500 response.
// Only the secrets this function's role allows (template.yaml CheckScheduleRole).
export const handler = createHandler({
  platform: () => getRuntime({ secretKeys: SECRET_KEYS }).platform(),
  schema: () => getRuntime({ secretKeys: SECRET_KEYS }).schema,
  secrets: () => getRuntime({ secretKeys: SECRET_KEYS }).secrets(),
});
