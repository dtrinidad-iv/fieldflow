import { describe, expect, it, vi } from 'vitest';
import { badRequest } from '../../lib/errors.js';
import { header, json, MAX_BODY_BYTES, parseJsonBody, wrap } from '../../lib/http.js';

describe('json', () => {
  it('serializes the body with JSON and no-store headers', () => {
    expect(json(201, { id: 'a' })).toEqual({
      statusCode: 201,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: '{"id":"a"}',
    });
  });
});

describe('header', () => {
  it('finds headers case-insensitively', () => {
    expect(header({ headers: { 'x-fieldflow-secret': 's' } }, 'X-FieldFlow-Secret')).toBe('s');
  });

  it('returns undefined when there are no headers', () => {
    expect(header({}, 'x')).toBeUndefined();
  });
});

describe('parseJsonBody', () => {
  it('parses a JSON object', () => {
    expect(parseJsonBody({ body: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('decodes base64 bodies', () => {
    expect(parseJsonBody({ body: Buffer.from('{"a":2}').toString('base64'), isBase64Encoded: true })).toEqual({ a: 2 });
  });

  it.each([
    [{}, /required/],
    [{ body: '' }, /required/],
    [{ body: '{not json' }, /valid JSON/],
    [{ body: '[1,2]' }, /JSON object/],
    [{ body: 'null' }, /JSON object/],
    [{ body: '"text"' }, /JSON object/],
  ])('rejects %j with a 400', (event, message) => {
    expect(() => parseJsonBody(event)).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(message) }));
  });

  it('rejects an oversized body with a 413', () => {
    const body = JSON.stringify({ a: 'x'.repeat(MAX_BODY_BYTES) });
    expect(() => parseJsonBody({ body })).toThrow(expect.objectContaining({ status: 413 }));
  });
});

describe('wrap', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it('returns the handler result as JSON', async () => {
    const handler = wrap(() => Promise.resolve({ status: 200, body: { ok: true } }), { log });
    expect(await handler({})).toMatchObject({ statusCode: 200, body: '{"ok":true}' });
  });

  it('turns thrown errors into JSON error responses', async () => {
    const handler = wrap(() => {
      throw badRequest('bad');
    }, { log });
    expect(await handler({})).toMatchObject({ statusCode: 400, body: '{"error":"bad"}' });
  });

  it('turns rejected promises into a 500', async () => {
    const handler = wrap(() => Promise.reject(new Error('boom')), { log });
    expect(await handler({})).toMatchObject({ statusCode: 500, body: '{"error":"internal error"}' });
  });
});
