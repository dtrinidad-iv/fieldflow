// Exactly-once work for retried webhooks. A key is claimed (IN_PROGRESS, with a lease and an owner
// token) before the work starts; a finished result is stored (COMPLETED) and replayed to later
// deliveries.
// - a delivery that finds COMPLETED gets the stored result
// - one that finds IN_PROGRESS with a live lease gets 409, so the sender retries later
// - a failure releases the claim, unless the work marks the error `keepClaim` (a side effect may
//   already have happened): then the claim stays until its lease expires
// - an expired lease (crashed or timed-out invocation) can be taken over; the owner token stops
//   the old owner from completing or releasing the new owner's claim
// Only results the work marks `store: true` are kept: "not ready yet" answers must not stick.
// The lease must outlast the function's timeout (tests/infra/template.test.js checks this).
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';

export const LEASE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function withIdempotency(store, key, fn, { leaseMs = LEASE_MS, ttlDays = 30, now = Date.now, token = randomUUID() } = {}) {
  const at = now();
  const expiresAt = () => Math.floor((now() + ttlDays * DAY_MS) / 1000);
  const claim = await store.claim(key, { now: at, leaseUntil: at + leaseMs, expiresAt: expiresAt(), token });
  if (claim.status === 'completed') return { replayed: true, value: claim.result };
  if (claim.status === 'in_progress') throw new HttpError(409, 'this delivery is already being processed; retry later');

  let outcome;
  try {
    outcome = await fn();
  } catch (err) {
    if (!err?.keepClaim) await store.release(key, token).catch(() => {}); // let a retry run; the original error wins
    throw err;
  }
  if (outcome.store) {
    // If this fails, the side effects are already done: keep the claim (it expires with the lease)
    // rather than releasing it, and rely on the handler's own duplicate check for the retry.
    await store.complete(key, outcome.value, { expiresAt: expiresAt(), token });
  } else {
    await store.release(key, token);
  }
  return { replayed: false, value: outcome.value };
}

// In-memory store for tests. Results are stored as JSON, like DynamoDB, so tests see the same copy.
export function createMemoryStore() {
  const items = new Map();
  const owned = (key, token) => items.get(key)?.status === 'IN_PROGRESS' && items.get(key).token === token;
  return {
    items,
    claim(key, { now, leaseUntil, expiresAt, token }) {
      const item = items.get(key);
      if (item?.status === 'COMPLETED') return Promise.resolve({ status: 'completed', result: JSON.parse(item.result) });
      if (item?.status === 'IN_PROGRESS' && item.leaseUntil > now) return Promise.resolve({ status: 'in_progress' });
      items.set(key, { status: 'IN_PROGRESS', leaseUntil, expiresAt, token });
      return Promise.resolve({ status: 'claimed' });
    },
    complete(key, result, { expiresAt, token }) {
      if (owned(key, token)) items.set(key, { status: 'COMPLETED', result: JSON.stringify(result), expiresAt });
      return Promise.resolve();
    },
    release(key, token) {
      if (owned(key, token)) items.delete(key);
      return Promise.resolve();
    },
  };
}

// DynamoDB store (table key `key` (S), TTL attribute `expiresAt`), low-level client API.
// `client` is a DynamoDBClient; `commands` the matching command classes (injected for tests).
export function createDynamoStore({ client, commands, tableName }) {
  const { PutItemCommand, GetItemCommand, DeleteItemCommand } = commands;
  const conditionFailed = (err) => err?.name === 'ConditionalCheckFailedException';
  const ownedBy = (token) => ({
    ConditionExpression: '#s = :inProgress AND #t = :token',
    ExpressionAttributeNames: { '#s': 'status', '#t': 'token' },
    ExpressionAttributeValues: { ':inProgress': { S: 'IN_PROGRESS' }, ':token': { S: token } },
  });
  return {
    async claim(key, { now, leaseUntil, expiresAt, token }) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              key: { S: key },
              status: { S: 'IN_PROGRESS' },
              token: { S: token },
              leaseUntil: { N: String(leaseUntil) },
              expiresAt: { N: String(expiresAt) },
            },
            ConditionExpression: 'attribute_not_exists(#k) OR (#s = :inProgress AND #l < :now)',
            ExpressionAttributeNames: { '#k': 'key', '#s': 'status', '#l': 'leaseUntil' },
            ExpressionAttributeValues: { ':inProgress': { S: 'IN_PROGRESS' }, ':now': { N: String(now) } },
          }),
        );
        return { status: 'claimed' };
      } catch (err) {
        if (!conditionFailed(err)) throw err;
      }
      const { Item } = await client.send(new GetItemCommand({ TableName: tableName, Key: { key: { S: key } }, ConsistentRead: true }));
      if (Item?.status?.S === 'COMPLETED') return { status: 'completed', result: JSON.parse(Item.result.S) };
      return { status: 'in_progress' };
    },
    async complete(key, result, { expiresAt, token }) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: { key: { S: key }, status: { S: 'COMPLETED' }, result: { S: JSON.stringify(result) }, expiresAt: { N: String(expiresAt) } },
            ...ownedBy(token),
          }),
        );
      } catch (err) {
        if (!conditionFailed(err)) throw err; // another delivery took over the claim: leave it to that one
      }
    },
    async release(key, token) {
      try {
        await client.send(new DeleteItemCommand({ TableName: tableName, Key: { key: { S: key } }, ...ownedBy(token) }));
      } catch (err) {
        if (!conditionFailed(err)) throw err; // completed, gone, or taken over: nothing to release
      }
    },
  };
}
