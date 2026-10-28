import { describe, expect, it, vi } from 'vitest';
import { createDynamoStore, createMemoryStore, withIdempotency } from '../../lib/idempotency.js';

// A fake DynamoDB client that evaluates the store's conditions the way DynamoDB would.
function fakeDynamo() {
  const table = new Map();
  class Cmd {
    constructor(input) {
      this.input = input;
    }
  }
  class PutItemCommand extends Cmd {}
  class GetItemCommand extends Cmd {}
  class DeleteItemCommand extends Cmd {}
  const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  // The two conditions the store uses: "free to claim" (with :now) and "owned by :token".
  const passes = (input, item) => {
    const values = input.ExpressionAttributeValues ?? {};
    if (!input.ConditionExpression) return true;
    if (values[':now']) return !item || (item.status.S === 'IN_PROGRESS' && Number(item.leaseUntil.N) < Number(values[':now'].N));
    return item?.status.S === 'IN_PROGRESS' && item.token?.S === values[':token'].S;
  };
  const client = {
    send: vi.fn(async (cmd) => {
      const key = (cmd.input.Item ?? cmd.input.Key).key.S;
      const item = table.get(key);
      if (cmd instanceof GetItemCommand) return { Item: item };
      if (!passes(cmd.input, item)) throw conditionFailed();
      if (cmd instanceof PutItemCommand) table.set(key, cmd.input.Item);
      else table.delete(key);
      return {};
    }),
  };
  return { client, table, commands: { PutItemCommand, GetItemCommand, DeleteItemCommand } };
}

const stores = {
  memory: () => {
    const store = createMemoryStore();
    return { store, has: (k) => store.items.has(k), status: (k) => store.items.get(k)?.status };
  },
  dynamo: () => {
    const fake = fakeDynamo();
    return { store: createDynamoStore({ ...fake, tableName: 'Idem' }), fake, has: (k) => fake.table.has(k), status: (k) => fake.table.get(k)?.status.S };
  },
};

describe.each(Object.entries(stores))('withIdempotency (%s store)', (_, make) => {
  it('runs the work once and replays the stored result', async () => {
    const { store } = make();
    const work = vi.fn(async () => ({ store: true, value: { status: 201, body: { invoiceId: 'i1' } } }));
    const first = await withIdempotency(store, 'k', work);
    const second = await withIdempotency(store, 'k', work);
    expect(first).toEqual({ replayed: false, value: { status: 201, body: { invoiceId: 'i1' } } });
    expect(second).toEqual({ replayed: true, value: { status: 201, body: { invoiceId: 'i1' } } });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('answers 409 while another delivery holds a live lease', async () => {
    const { store, has } = make();
    let release;
    const slow = withIdempotency(store, 'k', () => new Promise((r) => (release = r)), { now: () => 1000 });
    await vi.waitFor(() => expect(has('k')).toBe(true));
    await expect(withIdempotency(store, 'k', vi.fn(), { now: () => 2000 })).rejects.toMatchObject({ status: 409 });
    release({ store: true, value: 'done' });
    await slow;
  });

  it('lets a delivery take over an expired lease, and the old owner can no longer complete or release it', async () => {
    const { store, has, status } = make();
    let clock = 0;
    let finishOld;
    const old = withIdempotency(store, 'k', () => new Promise((r) => (finishOld = r)), { now: () => clock, leaseMs: 1000, token: 'old' });
    await vi.waitFor(() => expect(has('k')).toBe(true));
    clock = 5000;
    let finishNew;
    const taken = withIdempotency(store, 'k', () => new Promise((r) => (finishNew = r)), { now: () => clock, leaseMs: 1000, token: 'new' });
    await vi.waitFor(() => expect(finishNew).toBeTypeOf('function'));
    finishOld({ store: false, value: 'old' }); // the old owner tries to release
    await old;
    expect(status('k')).toBe('IN_PROGRESS'); // still the new owner's claim
    finishNew({ store: true, value: 'new' });
    expect((await taken).value).toBe('new');
    expect(status('k')).toBe('COMPLETED');
  });

  it('releases the claim when the work fails, so a retry can run', async () => {
    const { store } = make();
    await expect(withIdempotency(store, 'k', async () => {
      throw new Error('upstream down');
    })).rejects.toThrow('upstream down');
    const retry = await withIdempotency(store, 'k', async () => ({ store: true, value: 'ok' }));
    expect(retry).toEqual({ replayed: false, value: 'ok' });
  });

  it('keeps the claim when the failed work says a side effect may have happened (keepClaim)', async () => {
    const { store } = make();
    await expect(withIdempotency(store, 'k', async () => {
      throw Object.assign(new Error('create timed out'), { keepClaim: true });
    }, { now: () => 0 })).rejects.toThrow('create timed out');
    await expect(withIdempotency(store, 'k', vi.fn(), { now: () => 1000 })).rejects.toMatchObject({ status: 409 });
    const afterLease = await withIdempotency(store, 'k', async () => ({ store: true, value: 'checked' }), { now: () => 120_000 });
    expect(afterLease.value).toBe('checked');
  });

  it('does not keep answers marked store: false', async () => {
    const { store } = make();
    await withIdempotency(store, 'k', async () => ({ store: false, value: 'not yet' }));
    const later = await withIdempotency(store, 'k', async () => ({ store: true, value: 'now' }));
    expect(later).toEqual({ replayed: false, value: 'now' });
  });
});

describe('dynamo store details', () => {
  it('sets the TTL in epoch seconds, and keeps the claim when completing fails', async () => {
    const { store, fake } = stores.dynamo();
    const day = 24 * 60 * 60 * 1000;
    await withIdempotency(store, 'k', async () => ({ store: true, value: 1 }), { now: () => 0, ttlDays: 30 });
    expect(fake.table.get('k').expiresAt.N).toBe(String((30 * day) / 1000));

    const send = fake.client.send.getMockImplementation();
    fake.client.send.mockImplementation((cmd) => (cmd.input.Item?.status?.S === 'COMPLETED' ? Promise.reject(new Error('throttled')) : send(cmd)));
    await expect(withIdempotency(store, 'k2', async () => ({ store: true, value: 2 }), { now: () => 0 })).rejects.toThrow('throttled');
    expect(fake.table.get('k2').status.S).toBe('IN_PROGRESS'); // not released: the work already happened
  });

  it('rethrows errors other than a failed condition', async () => {
    const { store, fake } = stores.dynamo();
    fake.client.send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(store.claim('k', { now: 0, leaseUntil: 1, expiresAt: 1, token: 't' })).rejects.toThrow('denied');
  });
});
