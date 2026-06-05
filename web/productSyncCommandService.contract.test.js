import test from "node:test";
import assert from "node:assert/strict";
import { ProductSyncCommandService } from "./services/productSync/ProductSyncCommandService.js";

function createDb() {
  const syncRows = new Map();
  const idempotencyRows = new Map();
  return {
    syncRows,
    idempotencyRows,
    syncHistory: {
      async create({ data }) {
        syncRows.set(data.id, { ...data });
        return syncRows.get(data.id);
      },
      async updateMany({ where, data }) {
        const row = syncRows.get(where.id);
        if (!row || row.shop !== where.shop) return { count: 0 };
        syncRows.set(where.id, { ...row, ...data });
        return { count: 1 };
      },
    },
    idempotencyRecord: {
      async deleteMany({ where }) {
        idempotencyRows.set(where.id, { deletedForShop: where.shop });
        return { count: 1 };
      },
    },
  };
}

test("product sync command checks entitlement before claiming idempotency", async () => {
  const calls = [];
  const service = new ProductSyncCommandService({
    db: createDb(),
    idempotencyStore: {
      async begin() {
        calls.push("begin");
        return { mode: "execute", recordId: "idem-1" };
      },
      async complete() {},
    },
    async loadSubscription(shop) {
      calls.push("loadSubscription");
      return { shop, planKey: "FREE", status: "FREE" };
    },
    async assertEntitlement() {
      calls.push("entitlement");
      const error = new Error("PRODUCT_SYNC_PAID_PLAN_REQUIRED");
      error.code = "FORBIDDEN";
      throw error;
    },
    async enqueueClearProductTypesJob() {},
    async clearCacheKey() {},
  });

  await assert.rejects(
    () => service.createClearProductTypesCommand({
      shop: "s1",
      idempotencyKey: "k1",
    }),
    /PRODUCT_SYNC_PAID_PLAN_REQUIRED/,
  );
  assert.deepEqual(calls, ["loadSubscription", "entitlement"]);
});

test("product sync command marks sync failed and clears idempotency when enqueue fails", async () => {
  const db = createDb();
  const service = new ProductSyncCommandService({
    db,
    idempotencyStore: {
      async begin() {
        return { mode: "execute", recordId: "idem-2" };
      },
      async complete() {
        throw new Error("complete should not run");
      },
    },
    async loadSubscription(shop) {
      return { shop, planKey: "PRO_MONTHLY", status: "ACTIVE" };
    },
    async assertEntitlement() {},
    async enqueueClearProductTypesJob() {
      throw new Error("QUEUE_DOWN");
    },
    async clearCacheKey() {},
  });

  await assert.rejects(
    () => service.createClearProductTypesCommand({
      shop: "s1",
      idempotencyKey: "k2",
    }),
    (error) => {
      assert.equal(error.code, "PRODUCT_SYNC_CLEAR_TYPES_COMMAND_FAILED");
      assert.match(error.cause.message, /QUEUE_DOWN/);
      return true;
    },
  );

  const [history] = Array.from(db.syncRows.values());
  assert.equal(history.shop, "s1");
  assert.equal(history.status, "failed");
  assert.equal(history.executionState, "failed");
  assert.equal(db.idempotencyRows.get("idem-2").deletedForShop, "s1");
});

test("product sync command clears every registered sync cache key", async () => {
  const cleared = [];
  const service = new ProductSyncCommandService({
    db: createDb(),
    idempotencyStore: {
      async begin() {
        return { mode: "execute", recordId: "idem-3" };
      },
      async complete() {},
    },
    async loadSubscription(shop) {
      return { shop, planKey: "PRO_MONTHLY", status: "ACTIVE" };
    },
    async assertEntitlement() {},
    async enqueueClearProductTypesJob() {},
    getSyncCacheKeys(shop) {
      return [`${shop}:sync_details`, `${shop}:sync_summary`, `${shop}:sync_summary:v2`];
    },
    async clearCacheKey(key) {
      cleared.push(key);
    },
  });

  const response = await service.createClearProductTypesCommand({
    shop: "s1",
    idempotencyKey: "k3",
    source: "test",
  });

  assert.equal(response.status, "QUEUED");
  assert.equal(typeof response.executionId, "string");
  assert.deepEqual(cleared, [
    "s1:sync_details",
    "s1:sync_summary",
    "s1:sync_summary:v2",
  ]);
});
