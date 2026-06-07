import test from "node:test";
import assert from "node:assert/strict";
import {
  SHOP_DATA_DELETION_STEPS,
  deleteAllShopData,
} from "./services/shopDataDeletionService.js";

function createDeletionDb() {
  const remaining = new Map(SHOP_DATA_DELETION_STEPS.map(({ model }) => [model, 1]));
  const calls = [];
  const db = {};

  for (const { model, client } of SHOP_DATA_DELETION_STEPS) {
    db[client] = {
      ...(model === "Shop"
        ? {
            findFirst: async () => ({ id: "legacy-shop-id" }),
          }
        : {}),
      deleteMany: async ({ where }) => {
        calls.push({ model, where });
        const count = remaining.get(model) || 0;
        remaining.set(model, 0);
        return { count };
      },
    };
  }

  return { db, calls, remaining };
}

test("deleteAllShopData removes every registered tenant model and is idempotent", async () => {
  const shop = "test-deletion.myshopify.com";
  const { db, calls, remaining } = createDeletionDb();
  const audits = [];
  const silentLogger = { info() {} };
  const auditWriter = async (entry) => audits.push(entry);

  const first = await deleteAllShopData(shop, {
    db,
    serviceLogger: silentLogger,
    auditWriter,
  });
  const second = await deleteAllShopData(shop, {
    db,
    serviceLogger: silentLogger,
    auditWriter,
  });

  assert.equal(Object.values(first).every((count) => count === 1), true);
  assert.equal(Object.values(second).every((count) => count === 0), true);
  assert.equal([...remaining.values()].every((count) => count === 0), true);
  assert.equal(audits.length, 2);
  assert.equal(calls.length, SHOP_DATA_DELETION_STEPS.length * 2);

  for (const call of calls.filter(({ model }) =>
    ["VariantMetafield", "DeadLetterChange", "BulkEditSession", "BulkEditChange", "SyncCursor"]
      .includes(model))) {
    assert.deepEqual(call.where, { shopId: "legacy-shop-id" });
  }
});
