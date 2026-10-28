// Errors a handler can throw, and the one place that turns them into HTTP responses.
// Responses never carry stack traces or upstream response bodies; the details go to the log.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// An upstream platform call failed. `status` is the upstream HTTP status (0 for network errors
// and timeouts). The upstream body is deliberately not kept. For an answer with an unexpected
// shape, `shape` holds its key names (never values), so the read-only check can report them.
export class PlatformError extends Error {
  constructor(status, operation, shape) {
    super(`${operation} failed${status ? ` with status ${status}` : ''}`);
    this.name = 'PlatformError';
    this.status = status;
    this.operation = operation;
    if (shape) this.shape = shape;
  }
}

// Key names of a response and of its first list element, for PlatformError.shape.
export function describeShape(data, listKey) {
  const keys = data && typeof data === 'object' ? Object.keys(data) : [typeof data];
  const list = listKey && Array.isArray(data?.[listKey]) ? data[listKey] : undefined; // eslint-disable-line security/detect-object-injection
  const first = list?.[0];
  return { keys, ...(first && typeof first === 'object' ? { itemKeys: Object.keys(first) } : {}) };
}

export const badRequest = (message) => new HttpError(400, message);
export const unauthorized = () => new HttpError(401, 'unauthorized');
export const notFound = (message = 'not found') => new HttpError(404, message);
export const payloadTooLarge = () => new HttpError(413, 'payload too large');

export function toResponse(err, log) {
  if (err instanceof HttpError) {
    if (err.status >= 500) log?.error('handler error', { error: err.message });
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof PlatformError) {
    log?.error('platform error', { operation: err.operation, status: err.status });
    return { status: 502, body: { error: 'upstream platform error' } };
  }
  log?.error('unexpected error', { error: err?.message, stack: err?.stack });
  return { status: 500, body: { error: 'internal error' } };
}
