import test from "node:test";
import assert from "node:assert/strict";
import {
  purgeDispatchedOutboxEvents,
  purgeExpiredBillingEvents,
  purgeExpiredFilterTracks,
  purgeExpiredExportHistories,
  purgeExpiredMirrorAnomalies,
  purgeExpiredOperationStageProgress,
  purgeExpiredSpreadsheetFiles,
  purgeExpiredTargetSnapshots,
  purgeOldChangeRecords,
  purgeRetiredMirrorBatches,
  retentionCutoff,
} from "./services/dataRetentionService.js";

test("retention cutoff uses the configured whole-day window", () => {
  const now = new Date("2026-06-07T00:00:00.000Z");
  assert.equal(
    retentionCutoff(90, now).toISOString(),
    "2026-03-09T00:00:00.000Z",
  );
});

test("change records purge in bounded batches and only for terminal jobs", async () => {
  const calls = [];
  const batches = [
    Array.from({ length: 1000 }, (_, index) => ({ id: `row-${index}` })),
    [{ id: "row-final" }],
  ];
  const delegate = {
    findMany: async (args) => {
      calls.push({ type: "find", args });
      return batches.shift() || [];
    },
    deleteMany: async (args) => {
      calls.push({ type: "delete", args });
      return { count: args.where.id.in.length };
    },
  };

  const result = await purgeOldChangeRecords({
    shop: "retention-test.myshopify.com",
    db: { changeRecord: delegate },
    now: new Date("2026-06-07T00:00:00.000Z"),
    sleepFn: async () => {},
  });

  assert.equal(result.deleted, 1001);
  const findCalls = calls.filter(({ type }) => type === "find");
  const deleteCalls = calls.filter(({ type }) => type === "delete");
  assert.equal(findCalls.length, 2);
  assert.equal(deleteCalls.length, 2);
  assert.equal(findCalls[0].args.take, 1000);
  assert.equal(findCalls[0].args.where.shop, "retention-test.myshopify.com");
  assert.deepEqual(
    findCalls[0].args.where.editHistory.statusNormalized.in,
    ["COMPLETED", "FAILED", "PARTIAL"],
  );
  assert.equal(deleteCalls[0].args.where.shop, "retention-test.myshopify.com");
  assert.equal(deleteCalls[0].args.where.id.in.length, 1000);
});

test("filter tracks purge expired rows and null-expiry rows after max age", async () => {
  const calls = [];
  const delegate = {
    findMany: async (args) => {
      calls.push({ type: "find", args });
      return [{ id: "expired-preview" }, { id: "old-null-expiry" }];
    },
    deleteMany: async (args) => {
      calls.push({ type: "delete", args });
      return { count: args.where.id.in.length };
    },
  };

  const result = await purgeExpiredFilterTracks({
    shop: "retention-test.myshopify.com",
    db: { filterTrack: delegate },
    now: new Date("2026-06-07T00:00:00.000Z"),
  });

  assert.equal(result.deleted, 2);
  const find = calls.find(({ type }) => type === "find").args;
  assert.equal(find.where.shop, "retention-test.myshopify.com");
  assert.deepEqual(find.where.OR[0], {
    expiresAt: { lte: new Date("2026-06-07T00:00:00.000Z") },
  });
  assert.equal(find.where.OR[1].expiresAt, null);
  assert.equal(
    find.where.OR[1].createdAt.lt.toISOString(),
    "2026-05-08T00:00:00.000Z",
  );
});

test("target snapshots purge by explicit purgeAfter", async () => {
  const calls = [];
  const delegate = {
    findMany: async (args) => {
      calls.push({ type: "find", args });
      return [{ id: "snapshot-1" }];
    },
    deleteMany: async (args) => {
      calls.push({ type: "delete", args });
      return { count: args.where.id.in.length };
    },
  };

  const now = new Date("2026-06-07T00:00:00.000Z");
  const result = await purgeExpiredTargetSnapshots({
    shop: "retention-test.myshopify.com",
    db: { targetSnapshot: delegate },
    now,
  });

  assert.equal(result.deleted, 1);
  assert.deepEqual(calls[0].args.where, {
    shop: "retention-test.myshopify.com",
    purgeAfter: { lte: now },
  });
});

test("spreadsheet and export history purge storage object before row", async () => {
  const calls = [];
  function makeDelegate(id, fileUrl) {
    return {
      findMany: async (args) => {
        calls.push({ type: "find", id, args });
        return [{ id, fileUrl, storageKey: null }];
      },
      deleteMany: async (args) => {
        calls.push({ type: "delete", id, args });
        return { count: args.where.id.in.length };
      },
    };
  }
  const deleteStorageObject = async ({ fileUrl }) => {
    calls.push({ type: "storage", fileUrl });
  };
  const now = new Date("2026-06-07T00:00:00.000Z");

  await purgeExpiredSpreadsheetFiles({
    shop: "retention-test.myshopify.com",
    db: { spreadsheetFile: makeDelegate("spreadsheet-1", "/tmp/import.csv") },
    now,
    deleteStorageObject,
  });
  await purgeExpiredExportHistories({
    shop: "retention-test.myshopify.com",
    db: { exportHistory: makeDelegate("export-1", "https://cdn.example/export.csv") },
    now,
    deleteStorageObject,
  });

  assert.equal(calls.filter(({ type }) => type === "storage").length, 2);
  assert.ok(
    calls.findIndex(({ type, fileUrl }) => type === "storage" && fileUrl === "/tmp/import.csv")
      < calls.findIndex(({ type, id }) => type === "delete" && id === "spreadsheet-1"),
  );
  assert.ok(
    calls.findIndex(({ type, fileUrl }) => type === "storage" && fileUrl === "https://cdn.example/export.csv")
      < calls.findIndex(({ type, id }) => type === "delete" && id === "export-1"),
  );
});

test("remaining operational retention models purge by explicit retention field", async () => {
  const now = new Date("2026-06-07T00:00:00.000Z");
  const calls = [];
  function delegateFor(model) {
    return {
      findMany: async (args) => {
        calls.push({ model, type: "find", args });
        return [{ id: `${model}-1` }];
      },
      deleteMany: async (args) => {
        calls.push({ model, type: "delete", args });
        return { count: args.where.id.in.length };
      },
    };
  }
  const db = {
    operationStageProgress: delegateFor("operationStageProgress"),
    mirrorAnomaly: delegateFor("mirrorAnomaly"),
    billingEvent: delegateFor("billingEvent"),
    outboxEvent: delegateFor("outboxEvent"),
  };

  await purgeExpiredOperationStageProgress({ shop: "retention-test.myshopify.com", db, now });
  await purgeExpiredMirrorAnomalies({ shop: "retention-test.myshopify.com", db, now });
  await purgeExpiredBillingEvents({ shop: "retention-test.myshopify.com", db, now });
  await purgeDispatchedOutboxEvents({ shop: "retention-test.myshopify.com", db, now });

  for (const model of ["operationStageProgress", "mirrorAnomaly", "billingEvent"]) {
    const find = calls.find((call) => call.model === model && call.type === "find").args;
    assert.deepEqual(find.where, {
      shop: "retention-test.myshopify.com",
      purgeAfter: { lte: now },
    });
  }
  const outboxFind = calls.find((call) => call.model === "outboxEvent" && call.type === "find").args;
  assert.deepEqual(outboxFind.where, {
    shop: "retention-test.myshopify.com",
    status: "DISPATCHED",
    purgeAfter: { lte: now },
  });
});

test("mirror purge protects active and previous batches for each resource type", async () => {
  const mirrorQueries = [];
  const deletedCollections = [];
  const cleanedBatches = [];
  const db = {
    store: {
      findFirst: async () => ({
        activeMirrorBatchId: "product-active",
        activeCollectionBatchId: "collection-active",
      }),
    },
    mirrorBatch: {
      findMany: async (args) => {
        mirrorQueries.push(args);
        if (args.where.resourceType === "PRODUCT_CATALOG") {
          return [{ id: "product-active" }, { id: "product-previous" }];
        }
        if (args.where.resourceType === "COLLECTION_CATALOG") {
          return [{ id: "collection-active" }, { id: "collection-previous" }];
        }
        return [{ id: "retired-batch" }];
      },
      deleteMany: async () => ({ count: 1 }),
    },
    collection: {
      findMany: async (args) => {
        if (deletedCollections.length) return [];
        return [{ id: "collection-row" }];
      },
      deleteMany: async ({ where }) => {
        deletedCollections.push(...where.id.in);
        return { count: where.id.in.length };
      },
    },
  };

  const result = await purgeRetiredMirrorBatches({
    shop: "mirror-retention.myshopify.com",
    db,
    now: new Date("2026-06-07T00:00:00.000Z"),
    cleanupBatch: async ({ previousBatchId }) => cleanedBatches.push(previousBatchId),
  });

  const candidateQuery = mirrorQueries.find(({ where }) => !where.resourceType);
  assert.deepEqual(
    new Set(candidateQuery.where.id.notIn),
    new Set([
      "product-active",
      "product-previous",
      "collection-active",
      "collection-previous",
    ]),
  );
  assert.deepEqual(cleanedBatches, ["retired-batch"]);
  assert.deepEqual(deletedCollections, ["collection-row"]);
  assert.equal(result.deleted, 1);
});
