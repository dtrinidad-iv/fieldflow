import { describe, expect, it } from 'vitest';
import { optionalString, requireEnum, requireId, requireNumber, requireString } from '../../lib/validate.js';

const fails = (fn, message) => expect(fn).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(message) }));

describe('validators', () => {
  it('requireString trims and enforces presence and length', () => {
    expect(requireString({ name: '  Ana ' }, 'name')).toBe('Ana');
    fails(() => requireString({}, 'name'), /^name is required$/);
    fails(() => requireString({ name: '   ' }, 'name'), /name is required/);
    fails(() => requireString({ name: 5 }, 'name'), /name is required/);
    fails(() => requireString({ name: 'abcd' }, 'name', { max: 3 }), /at most 3/);
  });

  it('does not read inherited properties', () => {
    fails(() => requireString(JSON.parse('{"__proto__": {"name": "x"}}'), 'name'), /required/);
    fails(() => requireString({}, 'constructor'), /required/);
  });

  it('optionalString allows absence but validates presence', () => {
    expect(optionalString({}, 'note')).toBeUndefined();
    expect(optionalString({ note: '' }, 'note')).toBeUndefined();
    expect(optionalString({ note: '   ' }, 'note')).toBeUndefined();
    expect(optionalString({ note: 'hi' }, 'note')).toBe('hi');
    fails(() => optionalString({ note: 'x'.repeat(5) }, 'note', { max: 2 }), /note/);
  });

  it('requireId accepts record ids only', () => {
    expect(requireId({ jobId: 'DVWQWRNZ49' }, 'jobId')).toBe('DVWQWRNZ49');
    for (const bad of ['', '../x', 'a b', 'x'.repeat(65), 7, null]) {
      fails(() => requireId({ jobId: bad }, 'jobId'), /jobId must be a record id/);
    }
  });

  it('requireEnum names the allowed values', () => {
    expect(requireEnum({ s: 'done' }, 's', ['open', 'done'])).toBe('done');
    fails(() => requireEnum({ s: 'x' }, 's', ['open', 'done']), /s must be one of: open, done/);
  });

  it('requireNumber parses numeric strings and checks the range', () => {
    expect(requireNumber({ qty: '3' }, 'qty')).toBe(3);
    expect(requireNumber({ qty: 2.5 }, 'qty', { min: 0 })).toBe(2.5);
    fails(() => requireNumber({ qty: 'abc' }, 'qty'), /qty must be a number/);
    fails(() => requireNumber({ qty: '' }, 'qty'), /qty must be a number/);
    for (const odd of ['0x10', '1e3', 'Infinity', '0b11', '1.', '.5']) {
      fails(() => requireNumber({ qty: odd }, 'qty'), /qty must be a number/);
    }
    fails(() => requireNumber({ qty: Infinity }, 'qty'), /number/);
    fails(() => requireNumber({ qty: -1 }, 'qty', { min: 0, max: 10 }), /between 0 and 10/);
  });
});
