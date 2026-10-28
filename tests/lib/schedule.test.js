import { describe, expect, it } from 'vitest';
import { bookingKey, conflictText, CONFLICT_PREFIX, MAX_LISTED } from '../../lib/schedule.js';

const job = (id, overrides = {}) => ({ id, status: 'Scheduled', technician: ['tech1'], scheduledDate: '2026-11-02', slot: 'Morning', ...overrides });

describe('schedule', () => {
  it('a booking is technician + date + slot, for open jobs only', () => {
    expect(bookingKey(job('a'))).toBe(bookingKey(job('b', { status: 'In Progress', technician: [{ id: 'tech1' }], slot: ' Morning ' })));
    expect(bookingKey(job('a'))).not.toBe(bookingKey(job('b', { slot: 'Afternoon' })));
    expect(bookingKey(job('a'))).not.toBe(bookingKey(job('b', { scheduledDate: '2026-11-03' })));
    expect(bookingKey(job('a'))).not.toBe(bookingKey(job('b', { technician: ['tech2'] })));
  });

  it.each([
    ['Completed', { status: 'Completed' }],
    ['Invoiced', { status: 'Invoiced' }],
    ['no technician', { technician: [] }],
    ['no date', { scheduledDate: '' }],
    ['no slot', { slot: null }],
  ])('a job that is %s holds no booking', (_, overrides) => {
    expect(bookingKey(job('a', overrides))).toBeNull();
  });

  it('compares non-string values by content, never as "[object Object]"', () => {
    const a = job('a', { scheduledDate: { date: '2026-11-02' } });
    expect(bookingKey(a)).toBe(bookingKey(job('b', { scheduledDate: { date: '2026-11-02' } })));
    expect(bookingKey(a)).not.toBe(bookingKey(job('c', { scheduledDate: { date: '2026-11-03' } })));
  });

  it('lists every other job with the same booking, sorted and once', () => {
    const others = [job('c'), job('a'), job('b'), job('b'), job('d', { slot: 'Evening' }), job('e', { status: 'Completed' })];
    expect(conflictText(job('a'), others)).toBe(`${CONFLICT_PREFIX}b, c`);
  });

  it(`lists at most ${MAX_LISTED} ids, so the text always fits a Text field`, () => {
    const others = Array.from({ length: 30 }, (_, i) => job(`j${String(i).padStart(2, '0')}`));
    expect(conflictText(job('a'), others)).toBe(`${CONFLICT_PREFIX}j00, j01, j02, j03, j04 and 25 more`);
  });

  it('is empty without a conflict, or for a job that holds no booking', () => {
    expect(conflictText(job('a'), [job('a'), job('x', { slot: 'Evening' })])).toBe('');
    expect(conflictText(job('a', { status: 'Completed' }), [job('b')])).toBe('');
  });
});
