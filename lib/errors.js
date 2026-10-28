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
// and timeouts). The upstream body is deliberately not kept.
export class PlatformError extends Error {
  constructor(status, operation) {
    super(`${operation} failed${status ? ` with status ${status}` : ''}`);
    this.name = 'PlatformError';
    this.status = status;
    this.operation = operation;
  }
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
