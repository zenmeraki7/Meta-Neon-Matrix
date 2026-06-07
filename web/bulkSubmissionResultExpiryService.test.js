import assert from "node:assert/strict";
import test from "node:test";
import {
  RESULT_URL_TTL_MS,
  checkExpiringResultFiles,
  markBulkSubmissionProcessed,
  recordBulkSubmissionResultUrl,
} from "./services/bulkEdit/bulkSubmissionResultExpiryService.js";

test("recordBulkSubmissionResultUrl stores a seven-day expiry once", async () => {
  const calls = [];
  const db = {
    bulkSubmission: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: 1 };
      },
    },
  };
  const now = new Date("2026-06-07T12:00:00.000Z");
  await recordBulkSubmissionResultUrl({
    db,
    shop: "expiry.myshopify.com",
    bulkOperationId: "gid://shopify/BulkOperation/1",
    resultUrl: "https://example.test/result.jsonl",
    now,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].data.resultUrl, "https://example.test/result.jsonl");
  assert.equal(
    calls[1].data.resultUrlExpiresAt.getTime(),
    now.getTime() + RESULT_URL_TTL_MS,
  );
  assert.equal(calls[1].where.resultUrlExpiresAt, null);
});

test("expiring result file is forced onto the ingest queue", async () => {
  const now = new Date("2026-06-07T12:00:00.000Z");
  const queued = [];
  const db = {
    bulkSubmission: {
      findMany: async () => [{
        id: "submission-1",
        shop: "expiry.myshopify.com",
        editHistoryId: "history-1",
        shopifyBulkOperationId: "gid://shopify/BulkOperation/1",
        resultUrl: "https://example.test/result.jsonl",
        resultUrlExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      }],
    },
  };
  const result = await checkExpiringResultFiles({
    db,
    shop: "expiry.myshopify.com",
    now,
    logger: { error() {} },
    enqueueResultIngest: async (...args) => queued.push(args),
  });

  assert.deepEqual(result, { scanned: 1, enqueued: 1, failed: 0 });
  assert.equal(queued[0][0].source, "result_file_expiry_rescue");
  assert.equal(queued[0][1].priority, 1);
});

test("expired result file marks the submission and edit failed", async () => {
  const now = new Date("2026-06-07T12:00:00.000Z");
  const writes = [];
  const db = {
    bulkSubmission: {
      findMany: async () => [{
        id: "submission-2",
        shop: "expiry.myshopify.com",
        editHistoryId: "history-2",
        shopifyBulkOperationId: "gid://shopify/BulkOperation/2",
        resultUrl: "https://example.test/expired.jsonl",
        resultUrlExpiresAt: new Date(now.getTime() - 1),
      }],
      updateMany: (args) => {
        writes.push(["submission", args]);
        return Promise.resolve({ count: 1 });
      },
    },
    editHistory: {
      findFirst: async () => ({ batch: { existing: true } }),
      updateMany: (args) => {
        writes.push(["history", args]);
        return Promise.resolve({ count: 1 });
      },
    },
    $transaction: async (operations) => Promise.all(operations),
  };

  const result = await checkExpiringResultFiles({
    db,
    shop: "expiry.myshopify.com",
    now,
    logger: { error() {} },
    enqueueResultIngest: async () => assert.fail("expired file must not be enqueued"),
  });

  assert.deepEqual(result, { scanned: 1, enqueued: 0, failed: 1 });
  assert.equal(writes[0][1].data.status, "FAILED");
  assert.equal(writes[1][1].data.failureStage, "RESULT_FILE_EXPIRED_UNPROCESSED");
});

test("processed submission records completion time", async () => {
  let update;
  const now = new Date("2026-06-07T12:00:00.000Z");
  await markBulkSubmissionProcessed({
    db: {
      bulkSubmission: {
        updateMany: async (args) => {
          update = args;
          return { count: 1 };
        },
      },
    },
    shop: "expiry.myshopify.com",
    bulkOperationId: "gid://shopify/BulkOperation/3",
    now,
  });
  assert.equal(update.data.status, "PROCESSED");
  assert.equal(update.data.processedAt, now);
});
