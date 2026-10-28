import { describe, expect, it } from 'vitest';
import { readConfig, TADABASE_BASE_URL } from '../../lib/config.js';

describe('readConfig', () => {
  it('has safe defaults', () => {
    expect(readConfig({})).toEqual({
      stage: 'dev',
      allowLiveWrites: false,
      tadabase: { baseUrl: TADABASE_BASE_URL, timeoutMs: 5000 },
    });
  });

  it('reads the stage and timeout', () => {
    expect(readConfig({ STAGE: 'prod', TADABASE_TIMEOUT_MS: '8000' })).toMatchObject({
      stage: 'prod',
      tadabase: { timeoutMs: 8000 },
    });
  });

  it('turns live writes on only for exactly "1"', () => {
    expect(readConfig({ FIELDFLOW_ALLOW_LIVE_WRITES: '1' }).allowLiveWrites).toBe(true);
    for (const value of ['true', 'yes', '01', ' 1', '1 ', '']) {
      expect(readConfig({ FIELDFLOW_ALLOW_LIVE_WRITES: value }).allowLiveWrites).toBe(false);
    }
  });

  it('keeps live writes off in sam local, which reads the template environment', () => {
    expect(readConfig({ FIELDFLOW_ALLOW_LIVE_WRITES: '1', AWS_SAM_LOCAL: 'true' }).allowLiveWrites).toBe(false);
  });

  it.each([
    [{ STAGE: 'staging' }, /STAGE/],
    [{ TADABASE_TIMEOUT_MS: 'soon' }, /TADABASE_TIMEOUT_MS/],
    [{ TADABASE_TIMEOUT_MS: '50' }, /TADABASE_TIMEOUT_MS/],
    [{ TADABASE_TIMEOUT_MS: '9000' }, /between 100 and 8000/],
  ])('rejects %j', (env, message) => {
    expect(() => readConfig(env)).toThrow(message);
  });
});
