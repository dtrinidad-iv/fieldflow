import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveWritesDisabledError } from '../../lib/platform/tadabase.js';
import { createRuntime, getRuntime, resetRuntimeForTests } from '../../lib/runtime.js';
import { REQUIRED_FIELDS } from '../../lib/schema.js';
import { createFakeTadabase } from './platform/fake-tadabase.js';

const schema = {
  tables: Object.fromEntries(
    Object.entries(REQUIRED_FIELDS).map(([t, f]) => [t, { id: `T_${t}`, fields: Object.fromEntries(Object.keys(f).map((n, i) => [n, `field_${i + 1}`])) }]),
  ),
};
const getParameters = vi.fn((names) =>
  Promise.resolve({ Parameters: names.map((n) => ({ Name: n, Value: `value-of-${n.split('/').pop()}` })) }),
);
const fake = () => createFakeTadabase({ seed: { T_jobs: [{ id: 'j1', field_1: 'Fix boiler' }] } });

afterEach(() => {
  resetRuntimeForTests();
  getParameters.mockClear();
});

describe('runtime', () => {
  it('builds a Tadabase adapter from the config and the SSM secrets', async () => {
    const { fetch, requests } = fake();
    const rt = createRuntime({ env: { STAGE: 'dev', FIELDFLOW_ALLOW_LIVE_WRITES: '1' }, schema, getParameters, fetch });
    const platform = await rt.platform();
    expect(await platform.getRecord('T_jobs', 'j1')).toMatchObject({ field_1: 'Fix boiler' });
    expect(requests[0].headers).toMatchObject({ 'X-Tadabase-App-id': 'value-of-app-id', 'X-Tadabase-App-Secret': 'value-of-app-secret' });
    await expect(platform.createRecord('T_jobs', {})).resolves.toMatchObject({ id: expect.any(String) });
    expect(rt.config.stage).toBe('dev');
  });

  it.each([
    ['live writes are not allowed', { STAGE: 'dev' }],
    ['the flag is not exactly "1"', { STAGE: 'dev', FIELDFLOW_ALLOW_LIVE_WRITES: 'true' }],
    ['running under sam local', { STAGE: 'dev', FIELDFLOW_ALLOW_LIVE_WRITES: '1', AWS_SAM_LOCAL: 'true' }],
  ])('refuses writes when %s', async (_, env) => {
    const { fetch, requests } = fake();
    const platform = await createRuntime({ env, schema, getParameters, fetch }).platform();
    await expect(platform.createRecord('T_jobs', {})).rejects.toBeInstanceOf(LiveWritesDisabledError);
    expect(requests).toEqual([]);
  });

  it('refuses to start with a placeholder mapping', () => {
    const placeholder = { ...schema, placeholder: true };
    expect(() => createRuntime({ env: { STAGE: 'dev' }, schema: placeholder, getParameters })).toThrow(/placeholder ids/);
  });

  it('reuses one runtime per container, and loads secrets once within the TTL', async () => {
    const options = { env: { STAGE: 'dev' }, schema, getParameters, fetch: fake().fetch };
    const rt = getRuntime(options);
    expect(getRuntime(options)).toBe(rt);
    await rt.platform();
    await rt.platform();
    expect(getParameters).toHaveBeenCalledTimes(1);
  });

  it('does not keep a runtime that failed to build', () => {
    expect(() => getRuntime({ env: { STAGE: 'nope' }, schema, getParameters })).toThrow(/STAGE/);
    expect(getRuntime({ env: { STAGE: 'dev' }, schema, getParameters }).config.stage).toBe('dev');
  });

  it('reports a secrets failure without values', async () => {
    const failing = vi.fn(() => Promise.resolve({ Parameters: [] }));
    const err = await createRuntime({ env: { STAGE: 'prod' }, schema, getParameters: failing }).platform().catch((e) => e);
    expect(err.message).toMatch(/missing or empty SSM parameters: \/fieldflow\/prod\/tadabase\/app-id/);
  });
});
