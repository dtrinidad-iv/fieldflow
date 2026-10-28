// Tadabase REST adapter (https://api.tadabase.io/api/v1, see CLAUDE.md "Tadabase API notes").
// - Every request sends the three auth headers, times out after timeoutMs, and refuses
//   redirects (the auth headers must never follow one to another host).
// - Writes (create, update, delete) throw before any request unless allowLiveWrites is exactly
//   true, which only the deployed stack sets (FIELDFLOW_ALLOW_LIVE_WRITES=1).
// - Ids are checked before they go into a URL path (see shared.js).
// - Upstream failures become PlatformError, without the upstream body. An answer that doesn't
//   have the expected shape is a failure too, never an empty result: an "empty" answer would
//   let an idempotency check create a duplicate.
// Response shapes (items/total_pages, item, recordId, type: "error") follow docs.tadabase.io;
// plan 03 confirms them with a read-only GET against the live app.
import { describeShape, PlatformError } from '../errors.js';
import { checkFilters, checkId, listAll, pageSize } from './shared.js';

export class LiveWritesDisabledError extends Error {
  constructor(operation) {
    super(`Live writes are disabled (${operation}). Only the deployed stack sets FIELDFLOW_ALLOW_LIVE_WRITES=1.`);
    this.name = 'LiveWritesDisabledError';
  }
}

export function createTadabasePlatform({
  appId,
  appKey,
  appSecret,
  baseUrl = 'https://api.tadabase.io/api/v1',
  timeoutMs = 5000,
  allowLiveWrites = false,
  fetch = globalThis.fetch,
}) {
  if (!appId || !appKey || !appSecret) throw new Error('Tadabase app id, key and secret are required');
  const headers = {
    'X-Tadabase-App-id': appId,
    'X-Tadabase-App-Key': appKey,
    'X-Tadabase-App-Secret': appSecret,
  };
  // Two builders, so a missing record id can never fall back to the collection URL.
  const recordsUrl = (tableId) => {
    checkId('table', tableId);
    return `${baseUrl}/data-tables/${tableId}/records`;
  };
  const recordUrl = (tableId, recordId) => {
    checkId('record', recordId);
    return `${recordsUrl(tableId)}/${recordId}`;
  };

  async function request(operation, method, url, body) {
    let res;
    let text;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch {
      throw new PlatformError(0, operation); // network error, redirect or timeout
    }
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new PlatformError(res.status, operation);
    if (text.trim() === '') return { data: {} }; // e.g. 204 after an update or delete
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new PlatformError(res.status, operation);
    }
    // Tadabase can answer 200 with { type: "error" }.
    if (data?.type === 'error') throw new PlatformError(res.status, operation);
    return { data };
  }

  function guardWrite(operation) {
    if (allowLiveWrites !== true) throw new LiveWritesDisabledError(operation);
  }

  const platform = {
    async listRecords(tableId, { filters = [], page = 1, limit } = {}) {
      checkFilters(filters);
      const params = new URLSearchParams({ page: String(page), limit: String(pageSize(limit)) });
      filters.forEach(({ field, operator, value }, i) => {
        params.set(`filters[items][${i}][field_id]`, field);
        params.set(`filters[items][${i}][operator]`, operator);
        params.set(`filters[items][${i}][val]`, String(value));
      });
      const { data, notFound } = await request('listRecords', 'GET', `${recordsUrl(tableId)}?${params}`);
      if (notFound) throw new PlatformError(404, 'listRecords');
      // The page count is required, not defaulted: without it, listAll would stop after page 1
      // and an idempotency lookup could miss the record it's looking for.
      const totalPages = Number(data.total_pages);
      if (!Array.isArray(data.items) || !Number.isInteger(totalPages) || totalPages < 0) {
        throw new PlatformError(200, 'listRecords', describeShape(data, 'items'));
      }
      return { items: data.items, page: Number(data.current_page) || page, totalPages: Math.max(1, totalPages) };
    },
    // Read-only: the app's tables, for filling in the mapping.
    async listTables() {
      const { data, notFound } = await request('listTables', 'GET', `${baseUrl}/data-tables`);
      if (notFound) throw new PlatformError(404, 'listTables');
      const tables = data.data_tables;
      if (!Array.isArray(tables) || tables.some((t) => !t?.id)) throw new PlatformError(200, 'listTables', describeShape(data, 'data_tables'));
      return tables.map((t) => ({ id: t.id, name: t.name }));
    },
    // Read-only: the table's fields, for checking the slug mapping. Keys follow the docs; when the
    // answer looks different, the PlatformError's shape names the real keys (no values).
    async listFields(tableId) {
      checkId('table', tableId);
      const { data, notFound } = await request('listFields', 'GET', `${baseUrl}/data-tables/${tableId}/fields`);
      if (notFound) throw new PlatformError(404, 'listFields');
      const fields = data.fields;
      if (!Array.isArray(fields) || fields.some((f) => typeof f?.slug !== 'string')) {
        throw new PlatformError(200, 'listFields', describeShape(data, 'fields'));
      }
      return fields.map((f) => ({ slug: f.slug, name: f.name, type: f.type }));
    },
    listAllRecords(tableId, options) {
      return listAll(platform.listRecords, tableId, options);
    },
    async getRecord(tableId, recordId) {
      const { data, notFound } = await request('getRecord', 'GET', recordUrl(tableId, recordId));
      if (notFound) return null;
      if (!data.item || typeof data.item !== 'object') throw new PlatformError(200, 'getRecord', describeShape(data));
      return data.item;
    },
    async createRecord(tableId, fields) {
      guardWrite('createRecord');
      const { data, notFound } = await request('createRecord', 'POST', recordsUrl(tableId), fields);
      if (notFound || !data.recordId) throw new PlatformError(notFound ? 404 : 200, 'createRecord');
      return { id: String(data.recordId) };
    },
    async updateRecord(tableId, recordId, fields) {
      guardWrite('updateRecord');
      const { notFound } = await request('updateRecord', 'POST', recordUrl(tableId, recordId), fields);
      if (notFound) throw new PlatformError(404, 'updateRecord');
    },
    async deleteRecord(tableId, recordId) {
      guardWrite('deleteRecord');
      const { notFound } = await request('deleteRecord', 'DELETE', recordUrl(tableId, recordId));
      if (notFound) throw new PlatformError(404, 'deleteRecord');
    },
  };
  return platform;
}
