// Rules both adapters share, so they can't drift apart. Kept out of index.js to avoid an
// import cycle (index.js re-exports the adapters).
import { PlatformError } from '../errors.js';

export const FILTER_OPERATORS = ['is', 'is not', 'contains'];
export const MAX_PAGE_SIZE = 100;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// Table and record ids end up in URL paths: an empty, `.` or `..` id would change which
// endpoint is called (an update could become a create). Reject them before any request.
export function checkId(kind, value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`invalid ${kind} id: ${JSON.stringify(value)}`);
}

export function checkFilters(filters = []) {
  for (const { operator } of filters) {
    if (!FILTER_OPERATORS.includes(operator)) throw new Error(`unknown filter operator: ${operator}`);
  }
}

export const pageSize = (limit = MAX_PAGE_SIZE) => Math.max(1, Math.min(Number(limit) || MAX_PAGE_SIZE, MAX_PAGE_SIZE));

// Walk the pages, but never more than maxPages, and stop when the time budget is spent, so the
// work always ends before the Lambda timeout (10 s) with a proper error response.
export async function listAll(listRecords, tableId, { filters, maxPages = 20, timeBudgetMs = 8000, now = Date.now } = {}) {
  const deadline = now() + timeBudgetMs;
  const items = [];
  for (let page = 1; ; page += 1) {
    if (page > maxPages) throw new Error(`listAllRecords(${tableId}) has more than ${maxPages} pages`);
    if (page > 1 && now() >= deadline) throw new PlatformError(0, `listAllRecords(${tableId}) ran out of time`);
    const result = await listRecords(tableId, { filters, page, limit: MAX_PAGE_SIZE });
    items.push(...result.items);
    if (page >= result.totalPages) return items;
  }
}
