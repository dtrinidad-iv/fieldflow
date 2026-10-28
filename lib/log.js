// One JSON line per log call, so CloudWatch Logs Insights can query the fields.
// Values under secret-looking keys are redacted at any depth, so logging a config can't leak
// credentials. Redaction goes by key name only: never log a whole API Gateway event (query
// strings and bodies are plain strings), log the ids you need instead.

const SECRET_KEY = /secret|key|token|passw|pwd|auth|cookie|credential|signature|session|bearer|jwt|private/i;
const MAX_DEPTH = 6;

export function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
    );
  }
  return value;
}

export function createLogger(base = {}, write = (line) => console.log(line)) {
  const emit = (level, message, fields) =>
    // level and message go last, so fields can't overwrite them.
    write(JSON.stringify({ ...redact(base), ...redact(fields ?? {}), level, message }));
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
