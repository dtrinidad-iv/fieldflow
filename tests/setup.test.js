import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it } from 'vitest';

// Runs at import time, before any beforeEach: must already be blocked.
const importTimeFetch = fetch('https://api.tadabase.io/api/v1/data-tables').catch((err) => err);

function socketError(open) {
  return new Promise((resolve) => {
    const req = open();
    req.on('error', resolve);
  });
}

describe('test setup', () => {
  it('blocks fetch to non-local hosts with a rejected promise', async () => {
    await expect(fetch('https://api.tadabase.io/api/v1/data-tables')).rejects.toThrow(/Network access is blocked/);
    await expect(fetch(new URL('https://example.com/x'))).rejects.toThrow(/Network access is blocked/);
  });

  it('blocks fetch made at import time', async () => {
    expect(await importTimeFetch).toBeInstanceOf(Error);
    expect((await importTimeFetch).message).toMatch(/Network access is blocked/);
  });

  it('blocks node:https, node:http and raw sockets (AWS SDK, axios, jsdom XHR)', async () => {
    expect((await socketError(() => https.get('https://api.tadabase.io/api/v1/x'))).message).toMatch(/Network access is blocked/);
    expect((await socketError(() => http.get('http://example.com/'))).message).toMatch(/Network access is blocked/);
    expect((await socketError(() => net.connect(443, 'example.com'))).message).toMatch(/Network access is blocked/);
  });

  it('still allows local servers', async () => {
    const server = http.createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('clears platform and AWS credentials from the environment', () => {
    expect(process.env.TADABASE_APP_SECRET).toBe('');
    expect(process.env.FIELDFLOW_ALLOW_LIVE_WRITES).toBe('');
    expect(process.env.WEBHOOK_SECRET).toBe('');
    expect(process.env.AWS_PROFILE).toBe('');
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('');
    expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBe('/dev/null');
  });
});
