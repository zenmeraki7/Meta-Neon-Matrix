import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "./services/idempotency/IdempotencyStoreService.js";

function createFakeIdempotencyDb() {
  const records = new Map();
  return {
    idempotencyRecord: {
      async findUnique({ where }) {
        return records.get(where.id) || null;
      },
      async create({ data }) {
        if (records.has(data.id)) {
          const err = new Error("duplicate");
          err.code = "P2002";
          throw err;
        }
        records.set(data.id, { ...data });
        return records.get(data.id);
      },
      async updateMany({ where, data }) {
        const record = records.get(where.id);
        if (!record) return { count: 0 };
        if (where.state && record.state !== where.state) return { count: 0 };
        if (where.ownerToken && record.ownerToken !== where.ownerToken) return { count: 0 };
        if (where.lockedUntil && record.lockedUntil !== where.lockedUntil) return { count: 0 };
        const updated = { ...record, ...data };
        records.set(where.id, updated);
        return { count: 1 };
      },
    },
  };
}

test("IdempotencyStoreService begin creates IN_PROGRESS record with ownerToken and lockedUntil", async () => {
  const db = createFakeIdempotencyDb();
  const service = new IdempotencyStoreService(db);
  const hash = buildIdempotencyRequestHash({ x: 1 });

  const result = await service.begin({
    shop: "test-shop.myshopify.com",
    scope: "CANCEL_EDIT",
    key: "key-1",
    requestHash: hash,
    lockTtlMs: 5000,
  });

  assert.equal(result.mode, "execute");
  assert.ok(result.recordId);
  assert.ok(result.ownerToken);

  const saved = await db.idempotencyRecord.findUnique({ where: { id: result.recordId } });
  assert.equal(saved.state, "IN_PROGRESS");
  assert.equal(saved.ownerToken, result.ownerToken);
  assert.ok(saved.lockedUntil);
});

test("IdempotencyStoreService complete updates state to COMPLETED using ownerToken", async () => {
  const db = createFakeIdempotencyDb();
  const service = new IdempotencyStoreService(db);
  const hash = buildIdempotencyRequestHash({ x: 1 });

  const begin = await service.begin({
    shop: "test-shop.myshopify.com",
    scope: "CANCEL_EDIT",
    key: "key-2",
    requestHash: hash,
  });

  const responsePayload = { success: true, stage: "CANCELLED" };
  await service.complete({
    recordId: begin.recordId,
    shop: "test-shop.myshopify.com",
    ownerToken: begin.ownerToken,
    response: responsePayload,
    resourceType: "EDIT_HISTORY",
    resourceId: "hist-123",
  });

  const saved = await db.idempotencyRecord.findUnique({ where: { id: begin.recordId } });
  assert.equal(saved.state, "COMPLETED");
  assert.deepEqual(saved.responseJson, responsePayload);
  assert.equal(saved.resourceType, "EDIT_HISTORY");
  assert.equal(saved.resourceId, "hist-123");

  // Replay test
  const replay = await service.begin({
    shop: "test-shop.myshopify.com",
    scope: "CANCEL_EDIT",
    key: "key-2",
    requestHash: hash,
  });

  assert.equal(replay.mode, "replay");
  assert.deepEqual(replay.response, responsePayload);
});

test("IdempotencyStoreService complete throws IDEMPOTENCY_OWNERSHIP_LOST when ownerToken mismatches", async () => {
  const db = createFakeIdempotencyDb();
  const service = new IdempotencyStoreService(db);
  const hash = buildIdempotencyRequestHash({ x: 1 });

  const begin = await service.begin({
    shop: "test-shop.myshopify.com",
    scope: "CANCEL_EDIT",
    key: "key-3",
    requestHash: hash,
  });

  await assert.rejects(
    () => service.complete({
      recordId: begin.recordId,
      shop: "test-shop.myshopify.com",
      ownerToken: "wrong-owner-token",
      response: { ok: true },
    }),
    (err) => {
      assert.equal(err.code, "IDEMPOTENCY_OWNERSHIP_LOST");
      return true;
    },
  );
});

test("IdempotencyStoreService allows takeover of expired lock", async () => {
  const db = createFakeIdempotencyDb();
  const service = new IdempotencyStoreService(db);
  const hash = buildIdempotencyRequestHash({ x: 1 });

  const begin1 = await service.begin({
    shop: "test-shop.myshopify.com",
    scope: "CANCEL_EDIT",
    key: "key-4",
    requestHash: hash,
    lockTtlMs: -1000, // already expired
  });

  const begin2 = await service.begin({
    shop: "test-shop.myshopify.com",
    scope: "CANCEL_EDIT",
    key: "key-4",
    requestHash: hash,
    lockTtlMs: 5000,
  });

  assert.equal(begin2.mode, "execute");
  assert.notEqual(begin1.ownerToken, begin2.ownerToken);
});
