import { db } from "../../repositories/repositoryDb.js";
import { JobCreationService } from "../../services/JobCreationService.js";
import logger from "../../utils/loggerUtils.js";

const VERIFY_QUEUE_NAME = process.env.BULK_EDIT_VERIFICATION_QUEUE || "bulk-edit-verification";
const VERIFY_JOB_NAME = "bulk-edit-verification";
const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 6,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10000 },
});

export async function enqueueBulkEditVerification(
  { historyId, shop, executionId, source },
  options = {},
) {
  const safeShop = String(shop || "").trim();
  const safeHistoryId = String(historyId || "").trim();
  if (!safeShop || !safeHistoryId) {
    throw new Error("VERIFICATION_ENQUEUE_REQUIRES_SHOP_AND_HISTORY_ID");
  }
  const derivedExecutionId = String(executionId || "").trim() || `history-${safeHistoryId}`;
  if (!executionId) {
    logger.warn("Verification enqueue called without execution identity", {
      shop: safeShop,
      historyId: safeHistoryId,
      source: source || null,
    });
  }
  const { jobId: requestedJobId, ...restOptions } = options;
  const jobId =
    requestedJobId
    || `bulk-edit-verify:${safeShop}:${safeHistoryId}:${derivedExecutionId}`;
  const jobOptions = {
    ...DEFAULT_JOB_OPTIONS,
    ...restOptions,
    jobId,
  };
  const intent = await db.operationEnqueueIntent.upsert({
    where: {
      shop_queueKey_dedupeKey: {
        shop: safeShop,
        queueKey: VERIFY_QUEUE_NAME,
        dedupeKey: jobId,
      },
    },
    create: {
      shop: safeShop,
      queueKey: VERIFY_QUEUE_NAME,
      jobName: VERIFY_JOB_NAME,
      payload: {
        historyId: safeHistoryId,
        shop: safeShop,
        executionId: executionId || null,
        source: source || null,
      },
      options: jobOptions,
      dedupeKey: jobId,
      status: "PENDING",
    },
    // First-write-wins: the original options remain canonical for this jobId.
    update: {},
  });
  let dispatched = false;
  try {
    dispatched = await JobCreationService.dispatchIntent(intent);
  } catch (error) {
    logger.warn("Verification dispatch failed; persisted intent is pending recovery", {
      shop: safeShop,
      historyId: safeHistoryId,
      jobId,
      message: error?.message || String(error),
    });
    await db.operationEnqueueIntent.updateMany({
      where: { id: intent.id, shop: safeShop, status: { in: ["PENDING", "DISPATCHING"] } },
      data: {
        status: "DISPATCH_FAILED",
        lastError: error?.message || String(error),
        runAt: new Date(),
      },
    }).catch(() => {});
  }
  return { intent, dispatched, jobId, pendingRecovery: !dispatched };
}
