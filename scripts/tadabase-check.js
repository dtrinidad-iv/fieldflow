// Read-only check of a live Tadabase app against config/tadabase.<stage>.json. You run it, with
// the API keys from your .env (Claude can't read .env):
//
//   node --env-file=.env scripts/tadabase-check.js dev
//
// - While the mapping still holds placeholders, it lists every table and field (id, name, slug,
//   type) so you can fill the mapping in.
// - After that, it checks every mapped table and slug, the list/get response shapes, and what the
//   API answers for a missing record and a missing table.
// It only reads: the adapter is built with allowLiveWrites false and only read methods are called.
// It prints ids, field names, types and counts, never credentials or record values.
/* eslint-disable security/detect-object-injection -- keys come from REQUIRED_FIELDS and the committed config */
import { pathToFileURL } from 'node:url';
import { createTadabasePlatform } from '../lib/platform/tadabase.js';
import { loadSchema, REQUIRED_FIELDS } from '../lib/schema.js';

// Loose matches, since the exact type names come from the live app.
const TYPE_HINTS = {
  text: ['text', 'auto'], // the guide allows Auto Increment for invoice numbers
  select: ['select', 'drop', 'radio'],
  equation: ['equation', 'formula', 'rollup', 'calc'],
  link: ['link', 'url'],
  'long text': ['long', 'rich', 'textarea'],
};
const typeMatches = (hint, actual) =>
  (TYPE_HINTS[hint] ?? [hint]).some((h) => String(actual ?? '').toLowerCase().includes(h));
// Only the shape of a value, never its content.
const shapeOf = (value) =>
  value === null || typeof value !== 'object' ? JSON.stringify(value ?? null) : `an object with ${Object.keys(value).length} keys`;
const MISSING_RECORD = 'fieldflowCheckMissing0';
const MISSING_TABLE = 'fieldflowCheckMissing0';

async function probe(fn) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

// For an unexpected answer, name the keys the API really sent (names only), so the mapping or the
// adapter can be fixed from this output alone.
function describeError(err) {
  if (err.name !== 'PlatformError') return err.message;
  const shape = err.shape
    ? `; response keys: ${err.shape.keys.join(', ')}${err.shape.itemKeys ? `; first item keys: ${err.shape.itemKeys.join(', ')}` : ''}`
    : '';
  return `PlatformError status ${err.status}${shape}`;
}

export async function discover(platform, print) {
  const listed = await probe(() => platform.listTables());
  if (!listed.ok) {
    print(`FAIL  can't list tables: ${listed.error}`);
    return { ok: false };
  }
  const tables = listed.value;
  print(`Tables in this app (${tables.length}). Fill config/tadabase.<stage>.json with these ids and slugs:`);
  let ok = true;
  for (const t of tables) {
    print(`\n${t.name}  id=${t.id}`);
    const fields = await probe(() => platform.listFields(t.id));
    if (!fields.ok) {
      ok = false;
      print(`  FAIL  can't list fields: ${fields.error}`);
      continue;
    }
    for (const f of fields.value) print(`  ${String(f.slug).padEnd(12)} ${String(f.type).padEnd(16)} ${f.name}`);
  }
  return { ok };
}

export async function check(platform, schema, print, required = REQUIRED_FIELDS) {
  let failures = 0;
  const report = (status, what, detail = '') => {
    if (status === 'FAIL') failures += 1;
    print(`${status.padEnd(5)} ${what}${detail ? `  ${detail}` : ''}`);
  };

  for (const [table, wanted] of Object.entries(required)) {
    const { id, fields: mapped } = schema.tables[table];
    const fields = await probe(() => platform.listFields(id));
    if (!fields.ok) {
      report('FAIL', `${table} (${id})`, `can't list fields: ${fields.error}`);
      continue;
    }
    const bySlug = new Map(fields.value.map((f) => [f.slug, f]));
    for (const [name, hint] of Object.entries(wanted)) {
      const field = bySlug.get(mapped[name]);
      if (!field) report('FAIL', `${table}.${name}`, `slug ${mapped[name]} not found in the table`);
      else if (!typeMatches(hint, field.type)) report('CHECK', `${table}.${name}`, `type is "${field.type}", expected ${hint}`);
      else report('OK', `${table}.${name}`, `${field.slug} "${field.name}" (${field.type})`);
    }
    const unmapped = fields.value.filter((f) => !Object.values(mapped).includes(f.slug));
    if (unmapped.length) report('INFO', `${table} unmapped fields`, unmapped.map((f) => `${f.slug} "${f.name}"`).join(', '));

    const list = await probe(() => platform.listRecords(id, { limit: 1 }));
    if (!list.ok) {
      report('FAIL', `${table} list shape`, list.error);
      continue;
    }
    report('OK', `${table} list shape`, `items, ${list.value.totalPages} page(s) of 1`);
    const first = list.value.items[0];
    if (!first) {
      report('INFO', `${table} get shape`, 'no records to read yet');
      continue;
    }
    const got = await probe(() => platform.getRecord(id, String(first.id)));
    if (!got.ok || !got.value) report('FAIL', `${table} get shape`, got.error ?? 'record listed but not found');
    else {
      const present = Object.values(mapped).filter((slug) => Object.hasOwn(got.value, slug)).length;
      report('OK', `${table} get shape`, `item with ${present}/${Object.keys(mapped).length} mapped fields present`);
    }
  }

  // What does a 404 mean? (plan 02 follow-up)
  const jobs = schema.tables.jobs.id;
  const missingRecord = await probe(() => platform.getRecord(jobs, MISSING_RECORD));
  report('INFO', 'missing record', missingRecord.ok ? `getRecord returns ${shapeOf(missingRecord.value)}` : missingRecord.error);
  const missingTable = await probe(() => platform.listRecords(MISSING_TABLE, { limit: 1 }));
  report('INFO', 'missing table', missingTable.ok ? 'listRecords succeeds (unexpected)' : missingTable.error);

  print(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  return { ok: failures === 0 };
}

export async function main({
  argv = process.argv,
  env = process.env,
  fetch = globalThis.fetch,
  print = console.log,
  schemaFor = loadSchema,
} = {}) {
  const stage = argv[2];
  if (!stage) {
    print('usage: node --env-file=.env scripts/tadabase-check.js <dev|prod>');
    return 2;
  }
  const schema = schemaFor(stage);
  const platform = createTadabasePlatform({
    appId: env.TADABASE_APP_ID,
    appKey: env.TADABASE_APP_KEY,
    appSecret: env.TADABASE_APP_SECRET,
    allowLiveWrites: false, // read only, always
    fetch,
  });
  const { ok } = schema.placeholder ? await discover(platform, print) : await check(platform, schema, print);
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`tadabase-check failed: ${err.message}`);
      process.exit(1);
    },
  );
}
