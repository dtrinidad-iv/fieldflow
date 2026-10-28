import { describe, expect, it, vi } from 'vitest';
import { badRequest, HttpError, notFound, payloadTooLarge, PlatformError, toResponse, unauthorized } from '../../lib/errors.js';

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('toResponse', () => {
  it.each([
    [badRequest('name is required'), 400, 'name is required'],
    [unauthorized(), 401, 'unauthorized'],
    [notFound(), 404, 'not found'],
    [payloadTooLarge(), 413, 'payload too large'],
  ])('maps %s to its own status', (err, status, message) => {
    expect(toResponse(err, log())).toEqual({ status, body: { error: message } });
  });

  it('maps a platform error to 502 without upstream detail, and logs the operation', () => {
    const l = log();
    const res = toResponse(new PlatformError(503, 'listRecords'), l);
    expect(res).toEqual({ status: 502, body: { error: 'upstream platform error' } });
    expect(l.error).toHaveBeenCalledWith('platform error', { operation: 'listRecords', status: 503 });
  });

  it('maps anything else to a bare 500 and keeps the stack in the log only', () => {
    const l = log();
    const res = toResponse(new Error('db password is hunter2'), l);
    expect(res).toEqual({ status: 500, body: { error: 'internal error' } });
    expect(JSON.stringify(res)).not.toContain('hunter2');
    expect(l.error.mock.calls[0][1].stack).toMatch(/Error/);
  });

  it('logs 5xx HttpErrors but not client errors', () => {
    const l = log();
    toResponse(badRequest('x'), l);
    expect(l.error).not.toHaveBeenCalled();
    toResponse(new HttpError(503, 'unavailable'), l);
    expect(l.error).toHaveBeenCalled();
  });

  it('describes network failures without a status', () => {
    expect(new PlatformError(0, 'getRecord').message).toBe('getRecord failed');
  });
});
