import { describe, expect, it, vi } from 'vitest';
import { createSecretLoader, parameterNames } from '../../lib/secrets.js';

const values = {
  '/fieldflow/dev/tadabase/app-id': 'test-app-id',
  '/fieldflow/dev/tadabase/app-key': 'test-app-key',
  '/fieldflow/dev/tadabase/app-secret': 'test-app-secret',
  '/fieldflow/dev/webhook-secret': 'test-webhook-secret',
};
const ssm = (store = values) =>
  vi.fn((names) =>
    Promise.resolve({
      Parameters: names.filter((n) => n in store).map((n) => ({ Name: n, Value: store[n] })),
      InvalidParameters: names.filter((n) => !(n in store)),
    }),
  );

describe('secrets', () => {
  it('loads all four parameters for the stage in one call', async () => {
    const getParameters = ssm();
    const secrets = await createSecretLoader({ stage: 'dev', getParameters }).load();
    expect(getParameters).toHaveBeenCalledTimes(1);
    expect(getParameters.mock.calls[0][0].sort()).toEqual(Object.values(parameterNames('dev')).sort());
    expect(secrets).toEqual({
      tadabase: { appId: 'test-app-id', appKey: 'test-app-key', appSecret: 'test-app-secret' },
      webhookSecret: 'test-webhook-secret',
    });
  });

  it('uses per-stage names', () => {
    expect(parameterNames('prod').appSecret).toBe('/fieldflow/prod/tadabase/app-secret');
  });

  it('names a missing or empty parameter without leaking any value', async () => {
    const partial = { ...values, '/fieldflow/dev/tadabase/app-key': '' };
    delete partial['/fieldflow/dev/webhook-secret'];
    const getParameters = ssm(partial);
    const err = await createSecretLoader({ stage: 'dev', getParameters }).load().catch((e) => e);
    expect(err.message).toBe('missing or empty SSM parameters: /fieldflow/dev/tadabase/app-key, /fieldflow/dev/webhook-secret');
    expect(err.message).not.toMatch(/test-app/);
  });

  it('serves from the cache within the TTL and reloads after it', async () => {
    let clock = 0;
    const getParameters = ssm();
    const loader = createSecretLoader({ stage: 'dev', getParameters, ttlMs: 1000, now: () => clock });
    await loader.load();
    clock = 999;
    await loader.load();
    expect(getParameters).toHaveBeenCalledTimes(1);
    clock = 1000;
    await loader.load();
    expect(getParameters).toHaveBeenCalledTimes(2);
  });

  it('shares one SSM call between concurrent loads', async () => {
    const getParameters = ssm();
    const loader = createSecretLoader({ stage: 'dev', getParameters });
    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(a).toBe(b);
    expect(getParameters).toHaveBeenCalledTimes(1);
  });

  it('fails closed once the cache has expired: no stale secrets after a failed refresh', async () => {
    let clock = 0;
    const getParameters = vi.fn().mockImplementationOnce(ssm()).mockRejectedValueOnce(new Error('ThrottlingException')).mockImplementation(ssm());
    const loader = createSecretLoader({ stage: 'dev', getParameters, ttlMs: 1000, now: () => clock });
    await loader.load();
    clock = 2000;
    await expect(loader.load()).rejects.toThrow('ThrottlingException');
    await expect(loader.load()).resolves.toMatchObject({ webhookSecret: 'test-webhook-secret' });
  });

  it('does not cache a failure', async () => {
    const getParameters = vi.fn().mockRejectedValueOnce(new Error('throttled')).mockImplementation(ssm());
    const loader = createSecretLoader({ stage: 'dev', getParameters });
    await expect(loader.load()).rejects.toThrow('throttled');
    await expect(loader.load()).resolves.toMatchObject({ webhookSecret: 'test-webhook-secret' });
  });
});
