import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { prisma } from "../../config/database.js";
import logger from "../../utils/loggerUtils.js";
import { handleProductEditOperation } from "../../helpers/webhookHelpers/bulkOperations/bulkEdit.js";

const QUEUE_NAME = "stuck-bulk-mutation-recovery";

export const stuckBulkMutationRecoveryQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

async function recoverStuckBulkMutations() {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);

  const stuck = await prisma.editHistory.findMany({
    where: {
      OR: [
        {
          status: "processing",
          executionState: "awaiting_shopify",
          bulkOperationId: { not: null },
          updatedAt: { lt: cutoff },
        },
        {
          undo: {
            path: ["status"],
            equals: "processing",
          },
          updatedAt: { lt: cutoff },
        },
      ],
    },
    select: {
      id: true,
      shop: true,
      status: true,
      executionState: true,
      bulkOperationId: true,
      undo: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });

  let recovered = 0;
  let skipped = 0;

  for (const history of stuck) {
    const undo = history.undo || {};

    const isUndo =
      undo?.status === "processing" &&
      undo?.state === "awaiting_shopify" &&
      undo?.bulkOperationId;

    const bulkOperationId = isUndo
      ? undo.bulkOperationId
      : history.bulkOperationId;

    if (!bulkOperationId) {
      skipped += 1;
      continue;
    }

    logger.info("Recovering stuck bulk mutation", {
      worker: "stuckBulkMutationRecoveryWorker",
      historyId: history.id,
      shop: history.shop,
      bulkOperationId,
      mode: isUndo ? "undo" : "edit",
    });

    try {
      await handleProductEditOperation({
        shop: history.shop,
        bulkOperationId,
      });

      recovered += 1;
    } catch (error) {
      skipped += 1;

      logger.error("Failed to recover stuck bulk mutation", {
        worker: "stuckBulkMutationRecoveryWorker",
        historyId: history.id,
        shop: history.shop,
        bulkOperationId,
        mode: isUndo ? "undo" : "edit",
        message: error.message,
      });
    }
  }

  return { scanned: stuck.length, recovered, skipped };
}

export const stuckBulkMutationRecoveryWorker = new Worker(
  QUEUE_NAME,
  async () => recoverStuckBulkMutations(),
  {
    connection,
    concurrency: 1,
  }
);

stuckBulkMutationRecoveryWorker.on("completed", (job, result) => {
  logger.info("Stuck bulk mutation recovery completed", {
    worker: "stuckBulkMutationRecoveryWorker",
    jobId: job.id,
    result,
  });
});

stuckBulkMutationRecoveryWorker.on("failed", (job, error) => {
  logger.error("Stuck bulk mutation recovery failed", {
    worker: "stuckBulkMutationRecoveryWorker",
    jobId: job?.id,
    message: error.message,
  });
});

async function enqueueRecoveryJob() {
  try {
    await stuckBulkMutationRecoveryQueue.add(
      "recover-stuck-bulk-mutations",
      {},
      {
        jobId: "recover-stuck-bulk-mutations",
      }
    );
  } catch (error) {
    logger.error("Failed to enqueue stuck bulk mutation recovery job", {
      worker: "stuckBulkMutationRecoveryWorker",
      message: error.message,
    });
  }
}

setInterval(enqueueRecoveryJob, 60_000);
await enqueueRecoveryJob();