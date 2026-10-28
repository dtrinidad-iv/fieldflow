import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler, handler } from '../../functions/health/handler.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('health', () => {
  it('returns ok with the stage', async () => {
    const res = await createHandler({ config: () => ({ stage: 'prod' }) })({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, stage: 'prod' });
  });

  it('answers a bad config with a 500 that reveals nothing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await createHandler({
      config: () => {
        throw new Error('STAGE must be one of dev, prod');
      },
    })({});
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal error' });
  });

  it('wires the exported handler to the environment', async () => {
    vi.stubEnv('STAGE', 'prod'); // not the default, so a hard-coded config would fail
    const res = await handler({});
    expect(JSON.parse(res.body)).toEqual({ ok: true, stage: 'prod' });
  });
});
