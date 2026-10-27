// Tests must never touch the network: a stray call could write to the live app.
// Every connection to a non-local host fails: fetch, node:http/https/net (AWS SDK, axios) and
// jsdom's XMLHttpRequest all open sockets through net.Socket, which is blocked below. This file
// runs before each test file is imported, so calls made at import time are caught too.
// Mock the call (vi.stubGlobal / the memory adapter) instead.
import net from 'node:net';
import { beforeEach, vi } from 'vitest';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function blockedError(host) {
  return new Error(`Network access is blocked in tests (${host}). Mock this call.`);
}

// Socket-level block. Node calls connect with (options), (port, host), (path) or an internal
// [options, callback] array.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = 'localhost';
  if (typeof first === 'object' && first !== null) {
    if (first.path) return realConnect.apply(this, args); // unix socket
    host = first.host ?? 'localhost';
  } else if (typeof first === 'number' || /^\d+$/.test(String(first))) {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else {
    return realConnect.apply(this, args); // unix socket path
  }
  if (!LOCAL_HOSTS.has(host)) {
    process.nextTick(() => this.destroy(blockedError(host)));
    return this;
  }
  return realConnect.apply(this, args);
};

// fetch gets a clear, promise-shaped error before any socket is opened.
const realFetch = globalThis.fetch;
function guardedFetch(input, init) {
  let url;
  try {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    url = new URL(href, globalThis.location?.href ?? 'http://localhost/');
  } catch (err) {
    return Promise.reject(err);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) return Promise.reject(blockedError(url.hostname));
  return realFetch(input, { ...init, redirect: 'manual' });
}

globalThis.fetch = guardedFetch;
// Tests may stub and unstub fetch; put the guard back before each one.
beforeEach(() => {
  vi.stubGlobal('fetch', guardedFetch);
});
