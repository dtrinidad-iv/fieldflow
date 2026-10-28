// A stand-in for the Tadabase REST API, served through an injected fetch (never the network).
// Response shapes follow docs.tadabase.io: list -> { type, items, total_pages, current_page },
// get -> { type, item }, create -> { type, recordId }.
const BASE = 'https://api.tadabase.io/api/v1';

export function createFakeTadabase({ seed = {} } = {}) {
  const tables = new Map(Object.entries(seed).map(([t, rows]) => [t, new Map(rows.map((r) => [r.id, { ...r }]))]));
  const requests = [];
  let nextId = 1;
  const reply = (status, body) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    requests.push({ url, method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const { pathname, searchParams } = new URL(url);
    // /data-tables/{tableId}/records[/{recordId}]
    const parts = pathname.replace(new URL(BASE).pathname, '').split('/').slice(1);
    if (parts[0] !== 'data-tables' || parts[2] !== 'records' || parts.length > 4 || !parts[1]) {
      return reply(404, { type: 'error', msg: 'unknown route' });
    }
    const [tableId, recordId] = [decodeURIComponent(parts[1]), parts[3] && decodeURIComponent(parts[3])];
    const rows = tables.get(tableId);
    if (!rows) return reply(404, { type: 'error', msg: 'table not found' });

    if (method === 'GET' && !recordId) {
      let items = [...rows.values()];
      for (let i = 0; searchParams.has(`filters[items][${i}][field_id]`); i += 1) {
        const field = searchParams.get(`filters[items][${i}][field_id]`);
        const op = searchParams.get(`filters[items][${i}][operator]`);
        const val = searchParams.get(`filters[items][${i}][val]`);
        items = items.filter((r) => {
          const actual = String(r[field] ?? '');
          return op === 'is' ? actual === val : op === 'is not' ? actual !== val : actual.includes(val);
        });
      }
      const page = Number(searchParams.get('page') || 1);
      const limit = Number(searchParams.get('limit') || 100);
      const total = Math.max(1, Math.ceil(items.length / limit));
      return reply(200, {
        type: 'success',
        items: items.slice((page - 1) * limit, page * limit),
        total_items: items.length,
        total_pages: total,
        current_page: page,
      });
    }
    if (method === 'GET') {
      return rows.has(recordId) ? reply(200, { type: 'success', item: rows.get(recordId) }) : reply(404, { type: 'error' });
    }
    if (method === 'POST' && !recordId) {
      const id = `tb${nextId++}`;
      rows.set(id, { ...JSON.parse(init.body), id });
      return reply(200, { type: 'success', msg: 'Record Added', recordId: id });
    }
    if (method === 'POST') {
      if (!rows.has(recordId)) return reply(404, { type: 'error' });
      rows.set(recordId, { ...rows.get(recordId), ...JSON.parse(init.body), id: recordId });
      return reply(200, { type: 'success', msg: 'Record Updated' });
    }
    if (method === 'DELETE') {
      return rows.delete(recordId) ? reply(200, { type: 'success', msg: 'Record Deleted' }) : reply(404, { type: 'error' });
    }
    return reply(405, { type: 'error' });
  }

  return { fetch, requests, tables };
}
