// The Tadabase table ids and field slugs, per stage, from config/tadabase.<stage>.json.
// Handlers use logical names (jobs.status); only this module knows the slugs (field_NN).
// docs/tadabase-setup.md describes every table and field listed here.
/* eslint-disable security/detect-object-injection -- table and field names come from this module
   and the committed config; toSlugs only accepts names that are mapped (Object.hasOwn) */
import { badRequest } from './errors.js';
import dev from '../config/tadabase.dev.json' with { type: 'json' };
import prod from '../config/tadabase.prod.json' with { type: 'json' };

// Every logical field the code relies on, with the Tadabase field type the setup guide asks for.
// The type is a hint for scripts/tadabase-check.js, matched loosely.
export const REQUIRED_FIELDS = {
  customers: { name: 'text', email: 'email', phone: 'phone', address: 'address' },
  technicians: { name: 'text', email: 'email', color: 'text' },
  jobs: {
    title: 'text',
    description: 'long text',
    scheduledDate: 'date',
    customer: 'connection',
    technician: 'connection',
    status: 'select',
    signature: 'long text',
    total: 'equation',
  },
  jobItems: { job: 'connection', description: 'text', quantity: 'number', unitPrice: 'currency', lineTotal: 'equation' },
  invoices: { job: 'connection', number: 'text', issuedDate: 'date', amount: 'currency', pdfLink: 'link' },
};

const SCHEMAS = { dev, prod };
const TABLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^field_\d+$/;

export function validateSchema(schema, required = REQUIRED_FIELDS) {
  const problems = [];
  const tableIds = new Map();
  for (const [table, fields] of Object.entries(required)) {
    const entry = Object.hasOwn(schema?.tables ?? {}, table) ? schema.tables[table] : undefined;
    if (!entry) {
      problems.push(`table ${table} is not mapped`);
      continue;
    }
    if (!TABLE_ID.test(entry.id ?? '')) problems.push(`table ${table} has an invalid id`);
    else if (tableIds.has(entry.id)) problems.push(`table ${table} reuses the id of ${tableIds.get(entry.id)}`);
    else tableIds.set(entry.id, table);
    for (const field of Object.keys(fields)) {
      if (!Object.hasOwn(entry.fields ?? {}, field)) problems.push(`${table}.${field} must be a field slug like field_12`);
    }
    // Every mapped field, required or extra, since toSlugs writes any of them.
    const seen = new Set();
    for (const [field, slug] of Object.entries(entry.fields ?? {})) {
      if (!SLUG.test(slug ?? '')) problems.push(`${table}.${field} must be a field slug like field_12`);
      else if (seen.has(slug)) problems.push(`${table}.${field} reuses slug ${slug}`);
      else seen.add(slug);
    }
  }
  if (problems.length) throw new Error(`invalid Tadabase mapping: ${[...new Set(problems)].join('; ')}`);
  return schema;
}

export function loadSchema(stage) {
  if (!Object.hasOwn(SCHEMAS, stage)) throw new Error(`no Tadabase mapping for stage ${stage}`);
  return validateSchema(SCHEMAS[stage]);
}

function entryOf(schema, table) {
  if (!Object.hasOwn(schema.tables, table)) throw new Error(`table ${table} is not mapped`);
  return schema.tables[table];
}
export const tableId = (schema, table) => entryOf(schema, table).id;
export const fieldsOf = (schema, table) => entryOf(schema, table).fields;

// Raw record ({ id, field_12: ... }) -> { id, title: ... }, mapped fields only.
export function toLogical(schema, table, record) {
  const out = { id: record.id };
  for (const [name, slug] of Object.entries(fieldsOf(schema, table))) {
    if (Object.hasOwn(record, slug)) out[name] = record[slug];
  }
  return out;
}

// { title: ... } -> { field_12: ... } for writes. Unknown names are an error, not dropped silently:
// a 400, since the names can come from a request body.
export function toSlugs(schema, table, values) {
  const fields = fieldsOf(schema, table);
  const out = {};
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(fields, name)) throw badRequest(`${table}.${name} is not a mapped field`);
    out[fields[name]] = value;
  }
  return out;
}
