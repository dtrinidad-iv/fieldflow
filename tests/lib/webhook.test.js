import { describe, expect, it, vi } from 'vitest';
import { verifySecret } from '../../lib/webhook.js';

const SECRET = 'test-webhook-secret';
const event = (headers) => ({ headers });

describe('verifySecret', () => {
  it('accepts the right secret, whatever the header case', () => {
    expect(() => verifySecret(event({ 'x-fieldflow-secret': SECRET }), SECRET)).not.toThrow();
    expect(() => verifySecret(event({ 'X-FieldFlow-Secret': SECRET }), SECRET)).not.toThrow();
  });

  it.each([
    ['a wrong secret', { 'x-fieldflow-secret': 'nope' }],
    ['a secret of a different length', { 'x-fieldflow-secret': `${SECRET}x` }],
    ['a secret with different case', { 'x-fieldflow-secret': SECRET.toUpperCase() }],
    ['a missing header', {}],
    ['the secret in another header', { authorization: SECRET }],
  ])('rejects %s with a 401', (_, headers) => {
    expect(() => verifySecret(event(headers), SECRET)).toThrow(expect.objectContaining({ status: 401 }));
  });

  it.each(['', undefined])('fails closed and logs when no secret is configured (%j)', (configured) => {
    const log = { error: vi.fn() };
    expect(() => verifySecret(event({ 'x-fieldflow-secret': '' }), configured, log)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(log.error).toHaveBeenCalledWith('webhook secret is not configured');
  });
});
