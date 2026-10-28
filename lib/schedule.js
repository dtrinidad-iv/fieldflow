// Double-booking (plan 07): a booking is technician + Scheduled Date + Slot, and only open jobs
// hold one. Pure, so every rule is tested directly; functions/check-schedule does the I/O.
import { connectionId } from './invoice.js';

export const OPEN_STATUSES = ['Scheduled', 'In Progress'];
export const CONFLICT_PREFIX = 'Double-booked with: ';

// Values are compared as Tadabase returns them. A non-string (e.g. a date object) is compared by
// its JSON, never as "[object Object]", which would make unrelated jobs look equal.
function part(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value.trim() : JSON.stringify(value);
}

// The job's booking, or null when it holds none: not open, or no technician, date or slot yet.
export function bookingKey(job) {
  if (!OPEN_STATUSES.includes(job?.status)) return null;
  const technician = connectionId(job.technician);
  const date = part(job.scheduledDate);
  const slot = part(job.slot);
  if (!technician || !date || !slot) return null;
  return JSON.stringify([technician, date, slot]);
}

// At most this many ids are listed, so the text always fits a Text field. If the app ever shortened
// a value, "write only when it changes" would never settle, and the writes would loop.
export const MAX_LISTED = 5;

// What the job's Schedule Conflict field should say, given the other jobs: the ids of the jobs
// that share its booking, sorted, or '' when there are none.
export function conflictText(job, others) {
  const key = bookingKey(job);
  if (!key) return '';
  const ids = [...new Set(others.filter((o) => o.id !== job.id && bookingKey(o) === key).map((o) => o.id))].sort();
  if (!ids.length) return '';
  const listed = ids.slice(0, MAX_LISTED).join(', ');
  return CONFLICT_PREFIX + (ids.length > MAX_LISTED ? `${listed} and ${ids.length - MAX_LISTED} more` : listed);
}
