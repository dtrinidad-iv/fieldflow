// API Gateway (HTTP API, payload v2) request and response helpers.
import { badRequest, payloadTooLarge, toResponse } from './errors.js';
import { createLogger } from './log.js';

export const MAX_BODY_BYTES = 256 * 1024;

export function json(status, body) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export function header(event, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event?.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function parseJsonBody(event) {
  const raw = event?.body;
  if (raw === undefined || raw === null || raw === '') throw badRequest('request body is required');
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw payloadTooLarge();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('request body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('request body must be a JSON object');
  }
  return parsed;
}

// Runs a handler body and turns anything it throws into a JSON error response.
// fn returns { status, body }.
export function wrap(fn, { log = createLogger() } = {}) {
  return async (event) => {
    try {
      const { status, body } = await fn(event);
      return json(status, body);
    } catch (err) {
      const { status, body } = toResponse(err, log);
      return json(status, body);
    }
  };
}
