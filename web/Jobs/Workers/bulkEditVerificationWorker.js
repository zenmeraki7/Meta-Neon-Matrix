import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { BulkEditVerificationService } from "../../services/bulkEdit/BulkEditVerificationService.js";
import {
  normalizeEditHistoryExecutionState,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { guardedEditHistoryUpdate } from "../../services/operationTransitionGuards.js";

const QUEUE_NAME = process.env.BULK_EDIT_VERIFICATION_QUEUE || "bulk-edit-verification";

async function processBulkEditVerification(job) {
  const { historyId, shop, executionId = null } = job.data || {};

  if (!historyId || !shop) {
    throw new Error("bulk edit verification job requires historyId and shop");
  }

  const history = await db.editHistory.findUnique({
    where: { id: historyId },
    select: {
      id: true,
      shop: true,
      executionIdentity: true,
      batch: true,
      executionStateNormalized: true,
      executionState: true,
      cancelRequestedAt: true,
    },
  });

  if (!history) throw new Error("Edit history not found");
  if (history.shop !== shop) throw new Error("SHOP_MISMATCH");
  if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
    return { skipped: true, reason: "stale_execution_identity", historyId, shop };
  }
  if (history.cancelRequestedAt) {
    return { skipped: true, reason: "operation_cancel_requested", historyId, shop };
  }
  if (
    [
      OPERATION_LIFECYCLE_STATES.CANCELLED,
      OPERATION_LIFECYCLE_STATES.COMPLETED,
      OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
    ].includes(history.executionState)
  ) {
    return { skipped: true, reason: "operation_already_terminal", historyId, shop };
  }

  if (history.batch?.verification?.verifiedAt) {
    return { skipped: true, reason: "already_verified", historyId, shop };
  }

  const updated = await guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
      OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
      OPERATION_LIFECYCLE_STATES.VERIFYING,
      OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
    ],
    data: {
      executionState: OPERATION_LIFECYCLE_STATES.VERIFYING,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.VERIFYING,
      ),
    },
    extraWhere: {
      batch: {
        path: ["verification", "verifiedAt"],
        equals: null,
      },
    },
  });
  if (!updated) {
    throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_VERIFYING");
  }

  const service = new BulkEditVerificationService();
  return service.verifyBatch({ shop, historyId, executionId });
}

const bulkEditVerificationWorker = new Worker(
  QUEUE_NAME,
  processBulkEditVerification,
  {
    connection,
    concurrency: 2,
  },
);

export default bulkEditVerificationWorker;

