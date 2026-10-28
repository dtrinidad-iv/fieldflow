// GET /health: the smoke-test target for deploys. No secret, no data, no platform calls.
import { readConfig } from '../../lib/config.js';
import { wrap } from '../../lib/http.js';

export function createHandler({ config }) {
  return wrap(() => ({ status: 200, body: { ok: true, stage: config().stage } }));
}

// Config is read per request, so a bad environment is a 500 response, not a failed cold start.
export const handler = createHandler({ config: () => readConfig(process.env) });
