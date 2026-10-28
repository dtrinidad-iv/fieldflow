import { describe, expect, it, vi } from 'vitest';
import { listAll, pageSize } from '../../../lib/platform/shared.js';

const pages = (total) => vi.fn((_, { page }) => Promise.resolve({ items: [{ id: `p${page}` }], page, totalPages: total }));

describe('listAll', () => {
  it('collects every page', async () => {
    expect(await listAll(pages(3), 't')).toEqual([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);
  });

  it('stops when the time budget is spent, before the Lambda timeout', async () => {
    let clock = 0;
    const list = vi.fn((_, { page }) => {
      clock += 3000; // each page takes 3 s
      return Promise.resolve({ items: [{ id: page }], page, totalPages: 10 });
    });
    await expect(listAll(list, 't', { timeBudgetMs: 8000, now: () => clock })).rejects.toMatchObject({ name: 'PlatformError' });
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('pageSize', () => {
  it.each([[undefined, 100], [500, 100], [20, 20], [0, 100], [-5, 1], ['abc', 100]])('%j -> %j', (input, expected) => {
    expect(pageSize(input)).toBe(expected);
  });
});
