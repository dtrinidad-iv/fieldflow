import { describe, expect, it } from 'vitest';
import { loadSchema, REQUIRED_FIELDS, tableId, toLogical, toSlugs, validateSchema } from '../../lib/schema.js';

// A valid mapping built from REQUIRED_FIELDS: table ids T_<table>, slugs field_1, field_2, ...
const valid = () => ({
  tables: Object.fromEntries(
    Object.entries(REQUIRED_FIELDS).map(([table, fields]) => [
      table,
      { id: `T_${table}`, fields: Object.fromEntries(Object.keys(fields).map((f, i) => [f, `field_${i + 1}`])) },
    ]),
  ),
});

describe('schema', () => {
  it.each(['dev', 'prod'])('the committed %s mapping is valid', (stage) => {
    expect(() => loadSchema(stage)).not.toThrow();
  });

  it('rejects an unknown stage', () => {
    expect(() => loadSchema('staging')).toThrow(/no Tadabase mapping/);
    expect(() => loadSchema('__proto__')).toThrow(/no Tadabase mapping/);
  });

  it('accepts a complete mapping', () => {
    expect(validateSchema(valid())).toBeTruthy();
  });

  it.each([
    ['a missing table', (s) => delete s.tables.invoices, /table invoices is not mapped/],
    ['a missing field', (s) => delete s.tables.jobs.fields.status, /jobs.status must be a field slug/],
    ['a bad slug', (s) => (s.tables.jobs.fields.status = 'Status'), /jobs.status must be a field slug/],
    ['a duplicate slug', (s) => (s.tables.jobs.fields.status = s.tables.jobs.fields.title), /jobs.status reuses slug/],
    ['a bad table id', (s) => (s.tables.jobs.id = '../x'), /table jobs has an invalid id/],
    ['two tables with one id', (s) => (s.tables.invoices.id = s.tables.jobs.id), /table invoices reuses the id of jobs/],
    ['a bad slug in an extra field', (s) => (s.tables.jobs.fields.notes = 'Notes'), /jobs.notes must be a field slug/],
    ['an extra field reusing a slug', (s) => (s.tables.jobs.fields.notes = s.tables.jobs.fields.title), /jobs.notes reuses slug/],
  ])('rejects %s', (_, breakIt, message) => {
    const schema = valid();
    breakIt(schema);
    expect(() => validateSchema(schema)).toThrow(message);
  });

  it('maps records between slugs and logical names', () => {
    const schema = valid();
    const { title, status } = schema.tables.jobs.fields;
    const record = { id: 'r1', [title]: 'Fix boiler', [status]: 'Scheduled', field_999: 'unmapped' };
    expect(toLogical(schema, 'jobs', record)).toEqual({ id: 'r1', title: 'Fix boiler', status: 'Scheduled' });
    expect(toSlugs(schema, 'jobs', { title: 'Fix boiler', status: 'Completed' })).toEqual({ [title]: 'Fix boiler', [status]: 'Completed' });
  });

  it('refuses to write a field that is not mapped, with a 400', () => {
    expect(() => toSlugs(valid(), 'jobs', { colour: 'red' })).toThrow(
      expect.objectContaining({ status: 400, message: 'jobs.colour is not a mapped field' }),
    );
    expect(() => toSlugs(valid(), 'jobs', JSON.parse('{"__proto__": 1}'))).toThrow(/not a mapped field/);
  });

  it('only knows mapped tables, not inherited properties', () => {
    expect(() => toSlugs(valid(), '__proto__', { toString: 'x' })).toThrow(/table __proto__ is not mapped/);
    expect(() => tableId(valid(), 'constructor')).toThrow(/table constructor is not mapped/);
    expect(tableId(valid(), 'jobs')).toBe('T_jobs');
  });
});
