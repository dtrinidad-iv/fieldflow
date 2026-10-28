// In-memory platform adapter for tests and local runs. Same interface and rules as the
// Tadabase adapter (see index.js).
// - seed: { [tableId]: [records] }; tables: extra empty table ids. Any other table is unknown.
// - calls: every call made, for asserting on side effects (e.g. no duplicate create on a retry)
// - failNext(method, error): the next call to `method` rejects with `error`
import { PlatformError } from '../errors.js';
import { checkFilters, checkId, listAll, pageSize } from './shared.js';

function matches(record, filters = []) {
  return filters.every(({ field, operator, value }) => {
    // eslint-disable-next-line security/detect-object-injection -- field slugs come from config, not request input
    const actual = String(record[field] ?? '');
    if (operator === 'is') return actual === String(value);
    if (operator === 'is not') return actual !== String(value);
    return actual.includes(String(value));
  });
}

// Like the real adapter, every method returns a promise, and failures are rejections.
const asPromise = (fn) => (...args) => new Promise((resolve) => resolve(fn(...args)));

export function createMemoryPlatform({ seed = {}, tables: emptyTables = [] } = {}) {
  const tables = new Map(Object.entries(seed).map(([t, rows]) => [t, new Map(rows.map((r) => [r.id, { ...r }]))]));
  for (const t of emptyTables) if (!tables.has(t)) tables.set(t, new Map());
  const failures = new Map();
  const calls = [];
  let nextId = 1;

  const table = (tableId, operation) => {
    checkId('table', tableId);
    if (!tables.has(tableId)) throw new PlatformError(404, operation);
    return tables.get(tableId);
  };

  const call = (method, args) => {
    calls.push({ method, args });
    if (failures.has(method)) {
      const err = failures.get(method);
      failures.delete(method);
      throw err;
    }
  };

  const platform = {
    calls,
    failNext(method, error = new PlatformError(500, method)) {
      failures.set(method, error);
    },
    listRecords: asPromise((tableId, { filters, page = 1, limit } = {}) => {
      call('listRecords', [tableId, { filters, page, limit }]);
      checkFilters(filters);
      const size = pageSize(limit);
      const all = [...table(tableId, 'listRecords').values()].filter((r) => matches(r, filters));
      const totalPages = Math.max(1, Math.ceil(all.length / size));
      return { items: all.slice((page - 1) * size, page * size).map((r) => ({ ...r })), page, totalPages };
    }),
    listAllRecords(tableId, options) {
      return listAll(platform.listRecords, tableId, options);
    },
    getRecord: asPromise((tableId, recordId) => {
      call('getRecord', [tableId, recordId]);
      checkId('record', recordId);
      const record = table(tableId, 'getRecord').get(recordId);
      return record ? { ...record } : null;
    }),
    createRecord: asPromise((tableId, fields) => {
      call('createRecord', [tableId, fields]);
      const rows = table(tableId, 'createRecord');
      const id = `mem${nextId++}`;
      rows.set(id, { ...fields, id });
      return { id };
    }),
    updateRecord: asPromise((tableId, recordId, fields) => {
      call('updateRecord', [tableId, recordId, fields]);
      checkId('record', recordId);
      const rows = table(tableId, 'updateRecord');
      const record = rows.get(recordId);
      if (!record) throw new PlatformError(404, 'updateRecord');
      rows.set(recordId, { ...record, ...fields, id: recordId });
    }),
    deleteRecord: asPromise((tableId, recordId) => {
      call('deleteRecord', [tableId, recordId]);
      checkId('record', recordId);
      if (!table(tableId, 'deleteRecord').delete(recordId)) throw new PlatformError(404, 'deleteRecord');
    }),
  };
  return platform;
}
