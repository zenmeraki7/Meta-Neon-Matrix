import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIdempotencyRecordId,
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "./services/idempotency/IdempotencyStoreService.js";

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, "lte")) {
        return new Date(row[key]).getTime() <= new Date(expected.lte).getTime();
      }
    }
    return row[key] === expected;
  });
}

function createFakeDb() {
  const rows = new Map();
  return {
    filterTrack: {
      async create() {
        throw new Error("filterTrack must not store idempotency records");
      },
      async findFirst() {
        throw new Error("filterTrack must not store idempotency records");
      },
      async updateMany() {
        throw new Error("filterTrack must not store idempotency records");
      },
      async deleteMany() {
        throw new Error("filterTrack must not store idempotency records");
      },
    },
    idempotencyRecord: {
      rows,
      async create({ data }) {
        if (rows.has(data.id)) {
          const error = new Error("duplicate");
          error.code = "P2002";
          throw error;
        }
        const now = new Date();
        const row = {
          response: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          ...data,
        };
        rows.set(data.id, row);
        return row;
      },
      async findFirst({ where }) {
        return Array.from(rows.values()).find((row) => matchesWhere(row, where)) || null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, row] of rows.entries()) {
          if (matchesWhere(row, where)) {
            rows.set(id, { ...row, ...data, updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      },
      async deleteMany({ where }) {
        let count = 0;
        for (const [id, row] of Array.from(rows.entries())) {
          if (matchesWhere(row, where)) {
            rows.delete(id);
            count += 1;
          }
        }
        return { count };
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
  await service.complete({ recordId: first.recordId, shop: "s1", response });

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

test("idempotency in-progress duplicate fails conflict with retry guidance", async () => {
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
      assert.equal(typeof error.retryAfterSeconds, "number");
      assert.ok(error.retryAfterSeconds > 0);
      return true;
    },
  );
});

test("idempotency complete is scoped and only transitions in-progress records", async () => {
  const db = createFakeDb();
  const service = new IdempotencyStoreService(db);
  const hash = buildIdempotencyRequestHash({ x: 1 });
  const first = await service.begin({
    shop: "s1",
    scope: "IMPORT_CSV",
    key: "idem-4",
    requestHash: hash,
  });

  await assert.rejects(
    () => service.complete({
      recordId: first.recordId,
      shop: "s2",
      response: { leaked: true },
    }),
    /IDEMPOTENCY_RECORD_NOT_FOUND/,
  );

  await service.complete({
    recordId: first.recordId,
    shop: "s1",
    response: { ok: true },
  });
  await service.complete({
    recordId: first.recordId,
    shop: "s1",
    response: { ok: false },
  });

  const row = await db.idempotencyRecord.findFirst({
    where: { id: first.recordId, shop: "s1" },
  });
  assert.deepEqual(row.response, { ok: true });
});

test("expired in-progress idempotency records do not block forever", async () => {
  const db = createFakeDb();
  const service = new IdempotencyStoreService(db, { ttlMs: 1 });
  const requestHash = buildIdempotencyRequestHash({ x: 1 });
  const first = await service.begin({
    shop: "s1",
    scope: "IMPORT_CSV",
    key: "idem-5",
    requestHash,
  });
  const row = await db.idempotencyRecord.findFirst({
    where: { id: first.recordId, shop: "s1" },
  });
  row.expiresAt = new Date(Date.now() - 1000);

  const second = await service.begin({
    shop: "s1",
    scope: "IMPORT_CSV",
    key: "idem-5",
    requestHash,
  });
  assert.equal(second.mode, "execute");
  assert.equal(second.recordId, first.recordId);
});

test("idempotency oversized responses are rejected", async () => {
  const db = createFakeDb();
  const service = new IdempotencyStoreService(db, { maxResponseBytes: 16 });
  const first = await service.begin({
    shop: "s1",
    scope: "IMPORT_CSV",
    key: "idem-6",
    requestHash: buildIdempotencyRequestHash({ x: 1 }),
  });

  await assert.rejects(
    () => service.complete({
      recordId: first.recordId,
      shop: "s1",
      response: { tooLarge: "xxxxxxxxxxxxxxxxxxxxxxxx" },
    }),
    (error) => {
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.equal(error.message, "IDEMPOTENCY_RESPONSE_TOO_LARGE");
      return true;
    },
  );
});

test("idempotency record id is deterministic per shop/scope/key and uses full sha256", () => {
  const a = buildIdempotencyRecordId({ shop: "s1", scope: "IMPORT_CSV", key: "k1" });
  const b = buildIdempotencyRecordId({ shop: "s1", scope: "IMPORT_CSV", key: "k1" });
  const c = buildIdempotencyRecordId({ shop: "s1", scope: "IMPORT_CSV", key: "k2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^idem_[a-f0-9]{64}$/);
});
