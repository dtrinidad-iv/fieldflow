// Outgoing Tadabase webhooks carry a shared secret in the X-FieldFlow-Secret header.
import { createHash, timingSafeEqual } from 'node:crypto';
import { unauthorized } from './errors.js';
import { header } from './http.js';

export const SECRET_HEADER = 'X-FieldFlow-Secret';

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();

// Throws 401 unless the header matches. Comparing SHA-256 digests keeps the comparison
// constant-time and doesn't leak the secret's length. An empty configured secret is a
// misconfiguration and fails closed.
export function verifySecret(event, expected, log) {
  if (!expected) {
    log?.error('webhook secret is not configured');
    throw unauthorized();
  }
  const given = header(event, SECRET_HEADER);
  if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(expected))) {
    throw unauthorized();
  }
}
