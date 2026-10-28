// Runtime config from the environment. Secrets are not read here: plan 03 loads them from SSM.

export const STAGES = ['dev', 'prod'];
export const TADABASE_BASE_URL = 'https://api.tadabase.io/api/v1';

export function readConfig(env = process.env) {
  const stage = env.STAGE || 'dev';
  if (!STAGES.includes(stage)) throw new Error(`STAGE must be one of ${STAGES.join(', ')}`);
  const timeoutMs = env.TADABASE_TIMEOUT_MS ? Number(env.TADABASE_TIMEOUT_MS) : 5000;
  // Each request must finish well inside the 10 s Lambda timeout.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 8000) {
    throw new Error('TADABASE_TIMEOUT_MS must be an integer between 100 and 8000');
  }
  return {
    stage,
    // Exactly "1" and nothing else: a typo must never turn live writes on. `sam local` reads
    // the template's environment too, so a local container (AWS_SAM_LOCAL=true) never writes.
    allowLiveWrites: env.FIELDFLOW_ALLOW_LIVE_WRITES === '1' && env.AWS_SAM_LOCAL !== 'true',
    tadabase: { baseUrl: TADABASE_BASE_URL, timeoutMs },
  };
}
