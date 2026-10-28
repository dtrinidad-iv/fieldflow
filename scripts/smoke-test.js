// Read-only smoke test of a deployed stack (plan 08). Run it after every deploy, with the ApiUrl
// stack output:
//
//   node scripts/smoke-test.js https://<api-id>.execute-api.us-east-1.amazonaws.com dev   (or prod; required)
//
// It calls only this stack's own endpoints, never Tadabase, and changes nothing:
// - GET /health answers 200 { ok: true, stage }
// - the invoice link rejects a malformed path (400) and a wrong signature (403)
// - both webhooks reject a request without the secret (401), before doing any work
// It never sends X-FieldFlow-Secret, and it only accepts an execute-api URL, so it can't be
// pointed at the app or anywhere else.
import { pathToFileURL } from 'node:url';

const API_URL = /^https:\/\/[a-z0-9]{1,32}\.execute-api\.[a-z0-9-]{1,32}\.amazonaws\.com$/;
const TIMEOUT_MS = 10_000;
const WRONG_SIG = 'A'.repeat(43); // well-formed (43 base64url chars), but not the link's signature

export const CHECKS = [
  { name: 'health', method: 'GET', path: '/health', status: 200, body: (b, stage) => b?.ok === true && b.stage === stage },
  { name: 'invoice link, malformed path', method: 'GET', path: '/invoices/not-a-file', status: 400 },
  { name: 'invoice link, wrong signature', method: 'GET', path: `/invoices/smoketest.pdf?sig=${WRONG_SIG}`, status: 403 },
  { name: 'job-completed webhook, no secret', method: 'POST', path: '/webhooks/job-completed', status: 401 },
  { name: 'job-schedule webhook, no secret', method: 'POST', path: '/webhooks/job-schedule', status: 401 },
];

const STAGES = ['dev', 'prod'];

export async function run(apiUrl, { stage, fetch = globalThis.fetch, print = console.log } = {}) {
  const base = String(apiUrl ?? '').replace(/\/+$/, '');
  // The stage is required: without it, a prod URL would "pass" as dev.
  if (!API_URL.test(base) || !STAGES.includes(stage)) {
    print('usage: node scripts/smoke-test.js https://<api-id>.execute-api.<region>.amazonaws.com <dev|prod>');
    print('(the ApiUrl output of that stage\'s stack, read with describe-stacks; nothing else is accepted)');
    return 2;
  }
  let failures = 0;
  for (const check of CHECKS) {
    let line;
    try {
      const res = await fetch(base + check.path, {
        method: check.method,
        headers: check.method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: check.method === 'POST' ? JSON.stringify({ recordId: 'smoketest' }) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      let body;
      try {
        body = JSON.parse(await res.text());
      } catch {
        body = undefined;
      }
      const statusOk = res.status === check.status;
      const bodyOk = !check.body || check.body(body, stage);
      const why = statusOk && !bodyOk ? `, unexpected body (stage ${JSON.stringify(body?.stage ?? null)})` : '';
      line = `${statusOk && bodyOk ? 'OK  ' : 'FAIL'}  ${check.name}  ${check.method} ${check.path.split('?')[0]}  ${res.status} (expected ${check.status}${why})`;
      if (!(statusOk && bodyOk)) failures += 1;
    } catch (err) {
      failures += 1;
      line = `FAIL  ${check.name}  ${check.method} ${check.path.split('?')[0]}  ${err.name === 'TimeoutError' ? 'timed out' : 'request failed'}`;
    }
    print(line);
  }
  print(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  return failures ? 1 : 0;
}

// The command line: node scripts/smoke-test.js <ApiUrl> <dev|prod>. Resolves to the exit code.
export function main(argv = process.argv, options = {}) {
  return run(argv[2], { stage: argv[3], ...options });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`smoke-test failed: ${err.message}`);
      process.exit(1);
    },
  );
}
