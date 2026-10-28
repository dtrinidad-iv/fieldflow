// Stable, unguessable links to invoice PDFs: /invoices/<jobId>.pdf?sig=<HMAC-SHA256>. The HMAC
// key is the link-secret SSM parameter. The signed message carries a version (`v1`), so a
// version can be retired later without rotating the secret (which invalidates every link).
import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const mac = (jobId, secret) => createHmac('sha256', secret).update(`invoice:${VERSION}:${jobId}`).digest();

export function signInvoiceLink(jobId, secret) {
  if (!secret) throw new Error('link secret is not configured');
  return mac(jobId, secret).toString('base64url');
}

export function verifyInvoiceLink(jobId, sig, secret) {
  if (!secret || typeof sig !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
  const bytes = Buffer.from(sig, 'base64url');
  // Only the canonical spelling: the last character carries 2 unused bits.
  if (bytes.toString('base64url') !== sig) return false;
  return timingSafeEqual(bytes, mac(jobId, secret));
}

export function invoiceLink(baseUrl, jobId, secret) {
  return `${baseUrl}/invoices/${encodeURIComponent(jobId)}.pdf?sig=${signInvoiceLink(jobId, secret)}`;
}
