// The platform adapter interface. Handlers get an adapter injected through createHandler, so
// tests use the memory adapter and only the exported `handler` talks to Tadabase.
//
// Every method is async:
// - listRecords(tableId, { filters, page, limit }) -> { items, page, totalPages } (limit capped at 100)
// - listAllRecords(tableId, { filters, maxPages, timeBudgetMs }) -> items (bounded in pages and time)
// - getRecord(tableId, recordId) -> record | null
// - createRecord(tableId, fields) -> { id }
// - updateRecord(tableId, recordId, fields) -> void
// - deleteRecord(tableId, recordId) -> void
//
// A record is { id, ...fields }, with fields keyed by slug (field_NN). Filters are
// [{ field, operator: 'is' | 'is not' | 'contains', value }]. Ids must match [A-Za-z0-9_-]{1,64}.
// An unknown table rejects with PlatformError(404). The shared rules live in shared.js, and
// tests/lib/platform/contract.test.js runs the same suite against both adapters.

export { FILTER_OPERATORS, MAX_PAGE_SIZE } from './shared.js';
export { createMemoryPlatform } from './memory.js';
export { createTadabasePlatform, LiveWritesDisabledError } from './tadabase.js';
