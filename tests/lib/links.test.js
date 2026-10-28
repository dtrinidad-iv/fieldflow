import { describe, expect, it } from 'vitest';
import { invoiceLink, signInvoiceLink, verifyInvoiceLink } from '../../lib/links.js';

const SECRET = 'test-link-secret';
const flip = (ch) => (ch === 'A' ? 'B' : 'A');

describe('invoice links', () => {
  it('signs and verifies a job id', () => {
    const sig = signInvoiceLink('job42', SECRET);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyInvoiceLink('job42', sig, SECRET)).toBe(true);
  });

  it.each([
    ['another job', (sig) => ['job43', sig, SECRET]],
    ['another secret', (sig) => ['job42', sig, 'other-secret']],
    ['a tampered middle character', (sig) => ['job42', `${sig.slice(0, 20)}${flip(sig[20])}${sig.slice(21)}`, SECRET]],
    ['a missing signature', () => ['job42', undefined, SECRET]],
    ['a malformed signature', () => ['job42', 'short', SECRET]],
    ['no configured secret', (sig) => ['job42', sig, '']],
  ])('rejects %s', (_, args) => {
    expect(verifyInvoiceLink(...args(signInvoiceLink('job42', SECRET)))).toBe(false);
  });

  it('accepts only the canonical spelling of a signature', () => {
    const sig = signInvoiceLink('job42', SECRET);
    const bytes = Buffer.from(sig, 'base64url');
    // The last base64url character carries 2 unused bits: the other spellings decode to the same
    // bytes, and must still be rejected.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const variants = [...alphabet].map((c) => sig.slice(0, -1) + c).filter((s) => s !== sig && Buffer.from(s, 'base64url').equals(bytes));
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) expect(verifyInvoiceLink('job42', v, SECRET)).toBe(false);
  });

  it('signs a versioned message, so a version can be retired without rotating the secret', () => {
    expect(signInvoiceLink('job42', SECRET)).not.toBe(Buffer.from('invoice:job42').toString('base64url'));
  });

  it('builds the full link', () => {
    expect(invoiceLink('https://api.example.test', 'job42', SECRET)).toBe(
      `https://api.example.test/invoices/job42.pdf?sig=${signInvoiceLink('job42', SECRET)}`,
    );
  });

  it('refuses to sign without a secret', () => {
    expect(() => signInvoiceLink('job42', '')).toThrow(/not configured/);
  });
});
