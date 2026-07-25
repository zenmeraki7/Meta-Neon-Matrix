import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIdempotencyRecordId,
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "./services/idempotency/IdempotencyStoreService.js";

function createFakeDb() {
  const rows = new Map();
  return {
    filterTrack: {
      async findUnique({ where }) {
        return rows.get(where.id) || null;
      },
      async create({ data }) {
        if (rows.has(data.id)) {
          const err = new Error("duplicate");
          err.code = "P2002";
          throw err;
        }
        rows.set(data.id, { ...data });
        return rows.get(data.id);
      },
      async update({ where, data }) {
        const current = rows.get(where.id);
        if (!current) throw new Error("missing");
        const next = { ...current, ...data };
        rows.set(where.id, next);
        return next;
      },
    },
  };
}

test("idempotency duplicate replay returns same persisted result", async () => {
  const db = createFakeDb();
  const service = new IdempotencyStoreService(db);
  const key = "idem-1";
  const requestHash = buildIdempotencyRequestHash({ a: 1 });

  const first = await service.begin({
    shop: "s1",
    scope: "BULK_EDIT_EXECUTE",
    key,
    requestHash,
  });
  assert.equal(first.mode, "execute");

  const response = { operationId: "op-1", status: "TARGET_FREEZING" };
  await service.complete({ recordId: first.recordId, response });

  const replay = await service.begin({
    shop: "s1",
    scope: "BULK_EDIT_EXECUTE",
    key,
    requestHash,
  });
  assert.equal(replay.mode, "replay");
  assert.deepEqual(replay.response, response);
});

test("idempotency duplicate replay with different payload fails conflict", async () => {
  const db = createFakeDb();
  const service = new IdempotencyStoreService(db);
  const key = "idem-2";

  const first = await service.begin({
    shop: "s1",
    scope: "IMPORT_CSV",
    key,
    requestHash: buildIdempotencyRequestHash({ file: "a.csv" }),
  });
  assert.equal(first.mode, "execute");

  await assert.rejects(
    () => service.begin({
      shop: "s1",
      scope: "IMPORT_CSV",
      key,
      requestHash: buildIdempotencyRequestHash({ file: "b.csv" }),
    }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.publicCode, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      return true;
    },
  );
});

test("idempotency in-progress duplicate fails conflict", async () => {
  const db = createFakeDb();
  const service = new IdempotencyStoreService(db);
  const key = "idem-3";
  const hash = buildIdempotencyRequestHash({ x: 1 });

  const first = await service.begin({
    shop: "s1",
    scope: "IMPORT_CSV",
    key,
    requestHash: hash,
  });
  assert.equal(first.mode, "execute");

  await assert.rejects(
    () => service.begin({
      shop: "s1",
      scope: "IMPORT_CSV",
      key,
      requestHash: hash,
    }),
    (error) => {
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.publicCode, "IDEMPOTENCY_REQUEST_IN_PROGRESS");
      return true;
    },
  );
});

test("idempotency record id is deterministic per shop/scope/key", () => {
  const a = buildIdempotencyRecordId({ shop: "s1", scope: "IMPORT_CSV", key: "k1" });
  const b = buildIdempotencyRecordId({ shop: "s1", scope: "IMPORT_CSV", key: "k1" });
  const c = buildIdempotencyRecordId({ shop: "s1", scope: "IMPORT_CSV", key: "k2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

