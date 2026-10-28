import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../../lib/log.js';

describe('log', () => {
  it('redacts secret-looking keys at any depth', () => {
    const out = redact({
      headers: { 'X-FieldFlow-Secret': 's1', Authorization: 'Bearer t', accept: 'json' },
      config: { tadabase: { appKey: 'k', appSecret: 's2', appId: 'visible' } },
      list: [{ token: 't2', ok: 1 }],
    });
    expect(out).toEqual({
      headers: { 'X-FieldFlow-Secret': '[redacted]', Authorization: '[redacted]', accept: 'json' },
      config: { tadabase: { appKey: '[redacted]', appSecret: '[redacted]', appId: 'visible' } },
      list: [{ token: '[redacted]', ok: 1 }],
    });
  });

  it.each(['credentials', 'x-auth-token', 'Signature', 'sessionId', 'pwd', 'passwd', 'bearer', 'jwt', 'privateKey'])(
    'redacts %s',
    (key) => {
      expect(redact({ [key]: 'v' })).toEqual({ [key]: '[redacted]' });
    },
  );

  it('does not let fields overwrite the level or message', () => {
    const lines = [];
    createLogger({}, (line) => lines.push(line)).error('platform error', { level: 'info', message: 'all good' });
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', message: 'platform error' });
  });

  it('stops at a maximum depth instead of recursing forever', () => {
    const deep = {};
    let node = deep;
    for (let i = 0; i < 20; i += 1) node = node.child = {};
    expect(JSON.stringify(redact(deep))).toContain('[too deep]');
  });

  it('writes one JSON line per call with level, message and redacted fields', () => {
    const lines = [];
    const log = createLogger({ fn: 'health' }, (line) => lines.push(line));
    log.info('hello', { password: 'p', n: 1 });
    log.warn('careful');
    log.error('bad');
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { fn: 'health', password: '[redacted]', n: 1, level: 'info', message: 'hello' },
      { fn: 'health', level: 'warn', message: 'careful' },
      { fn: 'health', level: 'error', message: 'bad' },
    ]);
  });
});
