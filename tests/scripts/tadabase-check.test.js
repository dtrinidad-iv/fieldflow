// scripts/tadabase-check.js runs against the live app with real keys, so its promises matter most:
// it only reads (every test checks that no request but GET was made), and it never prints
// credentials or record values (checked in every mode).
import { describe, expect, it } from 'vitest';
import { check, discover, main } from '../../scripts/tadabase-check.js';
import { createTadabasePlatform } from '../../lib/platform/tadabase.js';
import { REQUIRED_FIELDS } from '../../lib/schema.js';
import { createFakeTadabase } from '../lib/platform/fake-tadabase.js';

const TYPES = { text: 'Text', email: 'Email', phone: 'Phone', address: 'Address', date: 'Date', connection: 'Connection',
  select: 'Drop Down', 'long text': 'Long Text', equation: 'Equation', number: 'Number', currency: 'Currency', link: 'Link' };
const RECORD_VALUE = 'Jane Customer, 12 Private Lane';
// Short, distinctive fakes (under the secret scan's 20-character threshold).
const CREDS = { appId: 'fake-id-7f3a', appKey: 'fake-key-9c1d', appSecret: 'fake-sec-2e8b' };
const ENV = { TADABASE_APP_ID: CREDS.appId, TADABASE_APP_KEY: CREDS.appKey, TADABASE_APP_SECRET: CREDS.appSecret };

const allGets = (fake) => fake.requests.every((r) => r.method === 'GET');
const leaks = (out) => [RECORD_VALUE, ...Object.values(CREDS)].filter((v) => out.includes(v));

// A live app that matches REQUIRED_FIELDS, with one record per table and one extra unmapped field.
function liveApp() {
  const schema = { tables: {} };
  const seed = {};
  const fields = {};
  for (const [table, wanted] of Object.entries(REQUIRED_FIELDS)) {
    const id = `T${table}`;
    const mapped = Object.fromEntries(Object.keys(wanted).map((f, i) => [f, `field_${i + 1}`]));
    schema.tables[table] = { id, fields: mapped };
    fields[id] = [
      ...Object.entries(wanted).map(([f, hint], i) => ({ slug: `field_${i + 1}`, name: f, type: TYPES[hint] })),
      { slug: 'field_99', name: 'Notes', type: 'Long Text' },
    ];
    seed[id] = [{ id: `${table}1`, ...Object.fromEntries(Object.values(mapped).map((slug) => [slug, RECORD_VALUE])) }];
  }
  const fake = createFakeTadabase({ seed, fields });
  return { schema, fake, fetch: fake.fetch };
}

// Wrap the fake so one endpoint answers with an unexpected shape.
function withAnswer(fetch, matches, body) {
  return (url, init) =>
    matches(new URL(url).pathname) ? Promise.resolve(new Response(JSON.stringify(body), { status: 200 })) : fetch(url, init);
}

async function runCheck(change = (app) => app) {
  const app = liveApp();
  const { schema, fetch } = change(app) ?? app;
  const platform = createTadabasePlatform({ ...CREDS, fetch: fetch ?? app.fetch });
  const lines = [];
  const result = await check(platform, schema ?? app.schema, (l) => lines.push(l));
  return { ...result, out: lines.join('\n'), fake: app.fake };
}

describe('tadabase-check: check mode', () => {
  it('passes a matching app, lists unmapped fields and reports the 404 behavior', async () => {
    const { ok, out, fake } = await runCheck();
    expect(ok).toBe(true);
    expect(out).toMatch(/^OK +jobs\.status +field_6 "status" \(Drop Down\)/m);
    expect(out).toMatch(/^OK +jobs list shape/m);
    expect(out).toMatch(/^OK +jobs get shape +item with 11\/11 mapped fields present/m);
    expect(out).toMatch(/^INFO +jobs unmapped fields +field_99 "Notes"/m);
    expect(out).toMatch(/^INFO +missing record +getRecord returns null/m);
    expect(out).toMatch(/^INFO +missing table +PlatformError status 404/m);
    expect(out).toMatch(/All checks passed/);
    expect(allGets(fake)).toBe(true);
    expect(leaks(out)).toEqual([]);
  });

  it.each([
    ['a missing table', (app) => { app.schema.tables.invoices.id = 'Tnope'; }, /^FAIL +invoices \(Tnope\) +can't list fields/m],
    ['a missing slug', (app) => { app.schema.tables.jobs.fields.status = 'field_77'; }, /^FAIL +jobs\.status +slug field_77 not found/m],
  ])('fails on %s', async (_, change, line) => {
    const { ok, out, fake } = await runCheck(change);
    expect(ok).toBe(false);
    expect(out).toMatch(line);
    expect(allGets(fake)).toBe(true);
  });

  it('flags a field of an unexpected type for a manual check, and survives odd type values', async () => {
    const { out } = await runCheck((app) => {
      app.schema.tables.jobs.fields.status = 'field_1'; // the title field, a Text
      app.schema.tables.jobs.fields.title = 'field_6';
      return { fetch: withAnswer(app.fetch, (p) => p.endsWith('/Tcustomers/fields'), { type: 'success', fields: [
        { slug: 'field_1', name: 'name', type: null }, { slug: 'field_2', name: 'email', type: { name: 'Email' } },
        { slug: 'field_3', name: 'phone', type: 'Phone' }, { slug: 'field_4', name: 'address', type: 'Address' },
      ] }) };
    });
    expect(out).toMatch(/^CHECK +jobs\.status +type is "Text", expected select/m);
    expect(out).toMatch(/^CHECK +customers\.name +type is "null", expected text/m);
  });

  it('accepts Auto Increment for the invoice number, as the setup guide allows', async () => {
    const { out } = await runCheck((app) => ({
      fetch: withAnswer(app.fetch, (p) => p.endsWith('/Tinvoices/fields'), { type: 'success', fields: [
        { slug: 'field_1', name: 'job', type: 'Connection' }, { slug: 'field_2', name: 'number', type: 'Auto Increment' },
        { slug: 'field_3', name: 'issuedDate', type: 'Date' }, { slug: 'field_4', name: 'amount', type: 'Currency' },
        { slug: 'field_5', name: 'pdfLink', type: 'Link' },
      ] }),
    }));
    expect(out).toMatch(/^OK +invoices\.number/m);
  });

  // The script's job is to confirm the documented shapes; when they differ, it must say what the
  // API really sent (key names only) instead of reporting OK.
  it.each([
    [
      'a list without total_pages',
      (p) => p.endsWith('/Tjobs/records'),
      { type: 'success', items: [{ id: 'j1', field_1: RECORD_VALUE }], pagination: { pages: 3 } },
      /^FAIL +jobs list shape +PlatformError status 200; response keys: type, items, pagination; first item keys: id, field_1$/m,
    ],
    [
      'fields under unexpected keys',
      (p) => p.endsWith('/Tjobs/fields'),
      { type: 'success', fields: [{ field_id: 'field_1', label: 'Title', fieldType: 'Text' }] },
      /^FAIL +jobs \(Tjobs\) +can't list fields: PlatformError status 200; response keys: type, fields; first item keys: field_id, label, fieldType$/m,
    ],
    [
      'a get without item',
      (p) => p.endsWith('/Tjobs/records/jobs1'),
      { type: 'success', record: { id: 'jobs1', field_1: RECORD_VALUE } },
      /^FAIL +jobs get shape +PlatformError status 200; response keys: type, record$/m,
    ],
  ])('reports the real keys for %s, without values', async (_, matches, body, line) => {
    const { ok, out, fake } = await runCheck((app) => ({ fetch: withAnswer(app.fetch, matches, body) }));
    expect(ok).toBe(false);
    expect(out).toMatch(line);
    expect(leaks(out)).toEqual([]);
    expect(allGets(fake)).toBe(true);
  });

  it('reports a non-null answer for a missing record by shape only', async () => {
    const { out } = await runCheck((app) => ({
      fetch: withAnswer(app.fetch, (p) => p.endsWith('/records/fieldflowCheckMissing0'), {
        type: 'success', item: { id: 'x', field_1: RECORD_VALUE },
      }),
    }));
    expect(out).toMatch(/^INFO +missing record +getRecord returns an object with 2 keys$/m);
    expect(leaks(out)).toEqual([]);
  });
});

describe('tadabase-check: discover mode and main', () => {
  it('lists tables and fields while the mapping holds placeholders', async () => {
    const app = liveApp();
    const lines = [];
    await discover(createTadabasePlatform({ ...CREDS, fetch: app.fetch }), (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toMatch(/^Table Tjobs {2}id=Tjobs$[^]*?^ {2}field_6 +Drop Down +status$/m);
    expect(allGets(app.fake)).toBe(true);
    expect(leaks(out)).toEqual([]);
  });

  it('reports the real keys when the tables answer looks different', async () => {
    const app = liveApp();
    const lines = [];
    const fetch = withAnswer(app.fetch, (p) => p.endsWith('/data-tables'), { type: 'success', tables: [{ table_id: 'x' }] });
    const { ok } = await discover(createTadabasePlatform({ ...CREDS, fetch }), (l) => lines.push(l));
    expect(ok).toBe(false);
    expect(lines[0]).toBe("FAIL  can't list tables: PlatformError status 200; response keys: type, tables");
  });

  it('runs discover mode for a placeholder mapping and check mode for a real one, read-only', async () => {
    const app = liveApp();
    const lines = [];
    const print = (l) => lines.push(l);
    const argv = ['node', 'x', 'dev'];
    expect(await main({ argv, env: ENV, fetch: app.fetch, print, schemaFor: () => ({ ...app.schema, placeholder: true }) })).toBe(0);
    expect(lines[0]).toMatch(/^Tables in this app/);
    expect(await main({ argv, env: ENV, fetch: app.fetch, print, schemaFor: () => app.schema })).toBe(0);
    expect(lines.at(-1)).toMatch(/All checks passed/);
    expect(allGets(app.fake)).toBe(true);
    expect(leaks(lines.join('\n'))).toEqual([]);
  });

  it('needs a stage, and fails (exit 1) on a broken mapping', async () => {
    const app = liveApp();
    expect(await main({ argv: ['node', 'x'], env: ENV, fetch: app.fetch, print: () => {} })).toBe(2);
    app.schema.tables.jobs.fields.status = 'field_77';
    expect(await main({ argv: ['node', 'x', 'dev'], env: ENV, fetch: app.fetch, print: () => {}, schemaFor: () => app.schema })).toBe(1);
  });
});
