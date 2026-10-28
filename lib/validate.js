// Small input validators. Each throws a 400 that names the field, and returns the clean value.
import { badRequest } from './errors.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function get(obj, key) {
  // Own properties only, so `__proto__` or `constructor` in a request body can't be read.
  // eslint-disable-next-line security/detect-object-injection -- key is a literal from handler code
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

export function requireString(obj, key, { max = 1000 } = {}) {
  const value = get(obj, key);
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} is required`);
  if (value.length > max) throw badRequest(`${key} must be at most ${max} characters`);
  return value.trim();
}

export function optionalString(obj, key, options) {
  const value = get(obj, key);
  const blank = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  return blank ? undefined : requireString(obj, key, options);
}

export function requireId(obj, key) {
  const value = get(obj, key);
  if (typeof value !== 'string' || !ID.test(value)) throw badRequest(`${key} must be a record id`);
  return value;
}

export function requireEnum(obj, key, allowed) {
  const value = get(obj, key);
  if (!allowed.includes(value)) throw badRequest(`${key} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function requireNumber(obj, key, { min = -Infinity, max = Infinity } = {}) {
  const raw = get(obj, key);
  // Plain decimals only: Number() would also accept "0x10", "1e3" and "Infinity".
  const value = typeof raw === 'string' && /^-?\d+$|^-?\d+\.\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`${key} must be a number`);
  if (value < min || value > max) throw badRequest(`${key} must be between ${min} and ${max}`);
  return value;
}
