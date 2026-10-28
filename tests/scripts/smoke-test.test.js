// scripts/smoke-test.js runs against a deployed stack, so its promises matter most: it only calls
// the stack's own execute-api URL, never sends the webhook secret, and reports every failure.
import { describe, expect, it, vi } from 'vitest';
import { CHECKS, main, run } from '../../scripts/smoke-test.js';

const API = 'https://abc123.execute-api.us-east-1.amazonaws.com';
const EXPECTED = {
  'GET /health': [200, { ok: true, stage: 'dev' }],
  'GET /invoices/not-a-file': [400, { error: 'expected /invoices/<jobId>.pdf' }],
  'GET /invoices/smoketest.pdf': [403, { error: 'invalid or missing link signature' }],
  'POST /webhooks/job-completed': [401, { error: 'unauthorized' }],
  'POST /webhooks/job-schedule': [401, { error: 'unauthorized' }],
};

// A fake deployed stack. `override` replaces one route's answer.
function stack(override = {}) {
  const answers = { ...EXPECTED, ...override };
  return vi.fn(async (url, init) => {
    const { pathname } = new URL(url);
    const answer = answers[`${init.method} ${pathname}`];
    if (answer instanceof Error) throw answer;
    const [status, body] = answer ?? [404, { error: 'not found' }];
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  });
}

// Explicit options (not default parameters), so a test can pass apiUrl or stage as undefined.
async function smoke(fetch, options = {}) {
  const { apiUrl, stage } = { apiUrl: API, stage: 'dev', ...options };
  const lines = [];
  const code = await run(apiUrl, { stage, fetch, print: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
}

describe('smoke-test', () => {
  it('passes a healthy stack: exit 0, one OK line per check', async () => {
    const fetch = stack();
    const { code, out } = await smoke(fetch);
    expect(code).toBe(0);
    expect(out.match(/^OK /gm)).toHaveLength(CHECKS.length);
    expect(out).toMatch(/All checks passed/);
  });

  it('accepts a trailing slash on the API URL', async () => {
    expect((await smoke(stack(), { apiUrl: `${API}/` })).code).toBe(0);
  });

  it.each(Object.keys(EXPECTED))('reports a wrong status on %s, exit 1', async (route) => {
    const { code, out } = await smoke(stack({ [route]: [500, { error: 'internal error' }] }));
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL /m);
    expect(out).toMatch(/1 check\(s\) failed/);
  });

  it('fails health when the stage is wrong, or the body is not { ok: true }', async () => {
    expect((await smoke(stack({ 'GET /health': [200, { ok: true, stage: 'prod' }] }))).code).toBe(1);
    expect((await smoke(stack({ 'GET /health': [200, 'not json'] }))).code).toBe(1);
    const { out } = await smoke(stack({ 'GET /health': [200, { ok: true, stage: 'prod' }] }));
    expect(out).toMatch(/FAIL +health .*200 \(expected 200, unexpected body \(stage "prod"\)\)/);
  });

  it.each([undefined, '', 'Dev', 'prd', 'staging'])('refuses the stage %j without making any request (exit 2)', async (stage) => {
    const fetch = stack();
    expect((await smoke(fetch, { stage })).code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a response whose body fails to read, and keeps going', async () => {
    const fetch = vi.fn(async () => ({ status: 200, text: async () => { throw new Error('reset'); } }));
    const { code, out } = await smoke(fetch);
    expect(code).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(CHECKS.length);
    // Health can't confirm its body; the rest expected 400/401/403, not 200.
    expect(out.match(/^FAIL /gm)).toHaveLength(CHECKS.length);
  });

  it('main() reads the API URL and stage from the command line and resolves to the exit code', async () => {
    const quiet = { print: () => {} };
    expect(await main(['node', 'smoke-test.js', API, 'dev'], { fetch: stack(), ...quiet })).toBe(0);
    expect(await main(['node', 'smoke-test.js', API, 'dev'], { fetch: stack({ 'GET /health': [500, {}] }), ...quiet })).toBe(1);
    expect(await main(['node', 'smoke-test.js'], { fetch: stack(), ...quiet })).toBe(2);
    expect(await main(['node', 'smoke-test.js', API], { fetch: stack(), ...quiet })).toBe(2);
  });

  it('reports a network error or a timeout per check, and keeps going', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetch = stack({ 'GET /health': new Error('ECONNREFUSED'), 'POST /webhooks/job-schedule': timeout });
    const { code, out } = await smoke(fetch);
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL +health .* request failed/);
    expect(out).toMatch(/FAIL +job-schedule webhook, no secret .* timed out/);
    expect(fetch).toHaveBeenCalledTimes(CHECKS.length);
  });

  it.each([
    'https://api.tadabase.io/api/v1',
    'http://abc123.execute-api.us-east-1.amazonaws.com',
    'https://abc123.execute-api.us-east-1.amazonaws.com.evil.test',
    'https://evil.test/abc123.execute-api.us-east-1.amazonaws.com',
    'https://abc123.execute-api.us-east-1.amazonaws.com/prefix',
    '',
    undefined,
  ])('refuses %j without making any request (exit 2)', async (url) => {
    const fetch = stack();
    expect((await smoke(fetch, { apiUrl: url })).code).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never sends the webhook secret, refuses redirects, and only calls the given API', async () => {
    const fetch = stack();
    await smoke(fetch);
    for (const [url, init] of fetch.mock.calls) {
      expect(url.startsWith(`${API}/`)).toBe(true);
      expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('x-fieldflow-secret');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
