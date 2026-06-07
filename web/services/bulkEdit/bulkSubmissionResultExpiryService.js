import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";

export const RESULT_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESULT_URL_RESCUE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function recordBulkSubmissionResultUrl({
  db,
  shop,
  bulkOperationId,
  resultUrl,
  now = new Date(),
}) {
  if (!resultUrl) return { count: 0 };
  const identity = { shop, shopifyBulkOperationId: String(bulkOperationId) };
  await db.bulkSubmission.updateMany({
    where: identity,
    data: { resultUrl },
  });
  return db.bulkSubmission.updateMany({
    where: { ...identity, resultUrlExpiresAt: null },
    data: {
      resultUrlExpiresAt: new Date(now.getTime() + RESULT_URL_TTL_MS),
      status: "RESULT_AVAILABLE",
      lastError: null,
    },
  });
}

export async function markBulkSubmissionProcessed({
  db,
  shop,
  bulkOperationId,
  now = new Date(),
}) {
  return db.bulkSubmission.updateMany({
    where: {
      shop,
      shopifyBulkOperationId: String(bulkOperationId),
      processedAt: null,
    },
    data: { status: "PROCESSED", processedAt: now, lastError: null },
  });
}

async function markExpiredSubmissionFailed({ db, submission, now }) {
  const history = await db.editHistory.findFirst({
    where: { id: submission.editHistoryId, shop: submission.shop },
    select: { batch: true },
  });
  await db.$transaction([
    db.bulkSubmission.updateMany({
      where: { id: submission.id, shop: submission.shop, processedAt: null },
      data: { status: "FAILED", lastError: "RESULT_FILE_EXPIRED_UNPROCESSED" },
    }),
    db.editHistory.updateMany({
      where: {
        id: submission.editHistoryId,
        shop: submission.shop,
        executionState: {
          notIn: [
            OPERATION_LIFECYCLE_STATES.COMPLETED,
            OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
            OPERATION_LIFECYCLE_STATES.FAILED,
            OPERATION_LIFECYCLE_STATES.CANCELLED,
          ],
        },
      },
      data: {
        status: "failed",
        statusNormalized: normalizeEditHistoryStatus("failed"),
        executionState: OPERATION_LIFECYCLE_STATES.FAILED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.FAILED,
        ),
        failureStage: "RESULT_FILE_EXPIRED_UNPROCESSED",
        batch: {
          ...(history?.batch && typeof history.batch === "object" ? history.batch : {}),
          resultIngestionFailure: {
            code: "RESULT_FILE_EXPIRED_UNPROCESSED",
            bulkOperationId: submission.shopifyBulkOperationId,
            resultUrlExpiresAt: submission.resultUrlExpiresAt?.toISOString?.() || null,
            failedAt: now.toISOString(),
          },
        },
      },
    }),
  ]);
}

export async function checkExpiringResultFiles({
  db,
  shop,
  enqueueResultIngest,
  logger,
  now = new Date(),
  limit = 100,
}) {
  const rescueBefore = new Date(now.getTime() + RESULT_URL_RESCUE_WINDOW_MS);
  const submissions = await db.bulkSubmission.findMany({
    where: {
      shop,
      resultUrl: { not: null },
      resultUrlExpiresAt: { lte: rescueBefore },
      processedAt: null,
      status: { not: "FAILED" },
    },
    orderBy: { resultUrlExpiresAt: "asc" },
    take: limit,
  });

  let enqueued = 0;
  let failed = 0;
  for (const submission of submissions) {
    logger.error("RESULT_FILE_EXPIRING_UNPROCESSED", {
      submissionId: submission.id,
      shop: submission.shop,
      expiresAt: submission.resultUrlExpiresAt,
    });
    if (
      !submission.resultUrlExpiresAt
      || submission.resultUrlExpiresAt.getTime() <= now.getTime()
    ) {
      // eslint-disable-next-line no-await-in-loop
      await markExpiredSubmissionFailed({ db, submission, now });
      failed += 1;
      continue;
    }
    const hourBucket = Math.floor(now.getTime() / (60 * 60 * 1000));
    // eslint-disable-next-line no-await-in-loop
    await enqueueResultIngest(
      {
        shop: submission.shop,
        bulkOperationId: submission.shopifyBulkOperationId,
        resultUrl: submission.resultUrl,
        source: "result_file_expiry_rescue",
      },
      {
        priority: 1,
        jobId: `result-expiry-rescue:${submission.id}:${hourBucket}`,
      },
    );
    enqueued += 1;
  }
  return { scanned: submissions.length, enqueued, failed };
}
