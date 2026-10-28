// Secrets from SSM Parameter Store (SecureString), one GetParameters call per load, cached for a
// few minutes per warm Lambda so a rotated secret takes effect without a redeploy.
// Errors name the missing parameter, never a value.

export const parameterNames = (stage) => ({
  appId: `/fieldflow/${stage}/tadabase/app-id`,
  appKey: `/fieldflow/${stage}/tadabase/app-key`,
  appSecret: `/fieldflow/${stage}/tadabase/app-secret`,
  webhookSecret: `/fieldflow/${stage}/webhook-secret`,
  linkSecret: `/fieldflow/${stage}/link-secret`,
});
export const ALL_SECRETS = Object.keys(parameterNames('x'));

// The real SSM call. The AWS SDK v3 ships in the Lambda runtime, so it's not a dependency: it's
// marked External in the esbuild metadata and only imported here, never in tests. One client per
// container, with short timeouts and one retry, so a stalled SSM fails well inside the 10 s Lambda
// timeout with a proper error response.
let ssm;
export async function ssmGetParameters(names) {
  const { SSMClient, GetParametersCommand } = await import('@aws-sdk/client-ssm');
  ssm ??= new SSMClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 } });
  return ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
}

// `keys` picks which secrets to load: a function's IAM role allows exactly those parameters, and
// GetParameters is denied as a whole if it names one the role can't read.
export function createSecretLoader({ stage, keys = ALL_SECRETS, getParameters = ssmGetParameters, ttlMs = 5 * 60 * 1000, now = Date.now }) {
  const all = parameterNames(stage);
  const names = Object.fromEntries(keys.map((k) => {
    if (!Object.hasOwn(all, k)) throw new Error(`unknown secret ${k}`);
    return [k, all[k]]; // eslint-disable-line security/detect-object-injection
  }));
  let cached;
  let loadedAt = 0;
  let pending;

  async function fetchAll() {
    const result = await getParameters(Object.values(names));
    const values = new Map((result?.Parameters ?? []).map((p) => [p.Name, p.Value]));
    const missing = Object.values(names).filter((n) => typeof values.get(n) !== 'string' || values.get(n) === '');
    if (missing.length) throw new Error(`missing or empty SSM parameters: ${missing.join(', ')}`);
    const get = (k) => (names[k] ? values.get(names[k]) : undefined); // eslint-disable-line security/detect-object-injection
    const secrets = {};
    if (names.appId) secrets.tadabase = { appId: get('appId'), appKey: get('appKey'), appSecret: get('appSecret') };
    if (names.webhookSecret) secrets.webhookSecret = get('webhookSecret');
    if (names.linkSecret) secrets.linkSecret = get('linkSecret');
    return secrets;
  }

  return {
    // Fails closed: once the cache has expired, a failed refresh throws instead of serving the
    // old values. Concurrent loads share one SSM call.
    load() {
      if (cached && now() - loadedAt < ttlMs) return Promise.resolve(cached);
      pending ??= fetchAll().then(
        (secrets) => {
          cached = secrets;
          loadedAt = now();
          pending = undefined;
          return secrets;
        },
        (err) => {
          pending = undefined;
          throw err;
        },
      );
      return pending;
    },
  };
}
