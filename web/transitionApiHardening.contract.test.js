import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFenceToken as normalizeExecutionFenceToken,
  serializeFenceToken,
  normalizePlainJsonObject,
  normalizeFailureText,
  findExecutionContext,
  findHistoryBatch,
  casBindSnapshotSet,
} from "./repositories/bulkEditExecutionRepository.js";
import {
  freezeTargetSnapshotSet,
  encodeSnapshotItemCursor,
  decodeSnapshotItemCursor,
  validateSnapshotCursorScope,
  findFrozenSnapshotBoundary,
} from "./repositories/targetSnapshotSetRepository.js";
import {
  isTransactionClient,
  runInRepositoryTransaction,
  normalizeInternalId,
  normalizeFenceToken,
  normalizeRetryDelay,
  claimBulkEditItemTx,
  markItemApplyingTx,
  markItemAppliedUnverifiedTx,
  claimOrCreateAppliedMutationTx,
  completeItemAndParentTx,
  markItemFailedTerminalTx,
  markBulkEditItemDeferredTx,
  maybeFinalizeParentTx,
  findBulkEditItemForApply,
  CLAIMABLE_STATES,
  UNCLAIMABLE_STATES,
  MAX_EXECUTION_ATTEMPTS,
  ITEM_LEASE_DURATION_MS,
} from "./repositories/bulkEditItemApplyRepository.js";
import { guardedEditHistoryUpdate } from "./services/operationTransitionGuards.js";

test("normalizeFenceToken handles BigInt and numeric string without JS Number conversion", () => {
  assert.equal(normalizeExecutionFenceToken(100n), 100n);
  assert.equal(normalizeExecutionFenceToken("9876543210123456789"), 9876543210123456789n);

  assert.throws(() => normalizeExecutionFenceToken(-10n), (err) => err.code === "INVALID_FENCE_TOKEN");
  assert.throws(() => normalizeExecutionFenceToken(12.34), (err) => err.code === "INVALID_FENCE_TOKEN");
  assert.throws(() => normalizeExecutionFenceToken("invalid"), (err) => err.code === "INVALID_FENCE_TOKEN");
  assert.throws(() => normalizeExecutionFenceToken(null), (err) => err.code === "INVALID_FENCE_TOKEN");
});

test("serializeFenceToken formats BigInt fence tokens as decimal strings across payloads", () => {
  assert.equal(serializeFenceToken(1234567890123456789n), "1234567890123456789");
  assert.equal(serializeFenceToken("999999"), "999999");
  assert.equal(serializeFenceToken(null), null);
});

test("normalizeInternalId validates ID length and allowed characters", () => {
  assert.equal(normalizeInternalId("  valid_id.123:shop  ", "ERR_CODE"), "valid_id.123:shop");

  assert.throws(() => normalizeInternalId(123, "ERR_CODE"), (err) => err.code === "ERR_CODE");
  assert.throws(() => normalizeInternalId("invalid space", "ERR_CODE"), (err) => err.code === "ERR_CODE");
  assert.throws(() => normalizeInternalId("a".repeat(200), "ERR_CODE"), (err) => err.code === "ERR_CODE");
  assert.throws(() => normalizeInternalId("invalid/slash", "ERR_CODE"), (err) => err.code === "ERR_CODE");
});

test("normalizeRetryDelay bounds retry delay within valid range", () => {
  assert.equal(normalizeRetryDelay(undefined), 300000);
  assert.equal(normalizeRetryDelay(5000), 5000);

  assert.throws(() => normalizeRetryDelay(500), (err) => err.code === "INVALID_RETRY_DELAY");
  assert.throws(() => normalizeRetryDelay(999999999), (err) => err.code === "INVALID_RETRY_DELAY");
  assert.throws(() => normalizeRetryDelay("invalid"), (err) => err.code === "INVALID_RETRY_DELAY");
});

test("maybeFinalizeParentTx transitions parent state with CAS when all items are terminal", async () => {
  let parentStatusUpdated = null;

  const mockTx = {
    editHistory: {
      findFirst: async () => ({
        id: "job-80",
        shop: "test.myshopify.com",
        stateVersion: 3,
        processedCount: 10,
        totalItems: 10,
        statusNormalized: "RUNNING",
        snapshotSetId: "set-80",
      }),
      updateMany: async ({ data }) => {
        parentStatusUpdated = data.statusNormalized;
        return { count: 1 };
      },
    },
    targetSnapshotSet: {
      findFirst: async () => ({
        itemCount: 10,
        mutationSucceededCount: 10,
        mutationFailedCount: 0,
        mutationConflictCount: 0,
        mutationCancelledCount: 0,
      }),
    },
  };

  const finalized = await maybeFinalizeParentTx({
    tx: mockTx,
    bulkApplyJobId: "job-80",
    shop: "test.myshopify.com",
  });

  assert.equal(finalized, true);
  assert.equal(parentStatusUpdated, "COMPLETED");
});

test("findBulkEditItemForApply uses narrowed select projection", async () => {
  let selectKeys = [];

  const mockTx = {
    targetSnapshotItem: {
      findFirst: async ({ select }) => {
        selectKeys = Object.keys(select);
        return { id: "item-90" };
      },
    },
  };

  const item = await findBulkEditItemForApply({
    bulkApplyJobId: "job-90",
    itemId: "item-90",
    shop: "test.myshopify.com",
    tx: mockTx,
  });

  assert.equal(item.id, "item-90");
  assert.ok(selectKeys.includes("plannedMutation"));
  assert.ok(selectKeys.includes("plannedValueHash"));
  assert.ok(!selectKeys.includes("rowChecksum"));
});
