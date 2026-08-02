import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "../Queues/bulkUndoResultIngestJob.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";
import {
  enqueueStuckBulkMutationRecoveryJob,
  enqueueStuckBulkMutationRecoveryTick,
} from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import { joinSafeJobId } from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = "stuck-bulk-mutation-recovery";
const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 60_000;
const LEADER_LOCK_KEY = "leader:stuck-bulk-mutation-recovery:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;

function buildRecoveryCooldownKey({ shop, shopifyBulkOperationId, mode }) {
  return `stuck-recovery-cooldown:${shop}:${shopifyBulkOperationId}:${mode}`;
}

async function recoverStuckBulkMutations() {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);

  const stuck = await db.editHistory.findMany({
    where: {
      OR: [
        {
          executionStateNormalized: OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
          updatedAt: { lt: cutoff },
        },
        {
          executionStateNormalized: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
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
      statusNormalized: true,
      executionStateNormalized: true,
      executionIdentity: true,
      shopifyBulkOperationId: true,
      batch: true,
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
      undo?.shopifyBulkOperationId;

    const shopifyBulkOperationId = isUndo
      ? undo.shopifyBulkOperationId
      : (
        history.batch?.shopifyBulkOperation?.id
        || history.batch?.shopifyBulkOperationId
        || history.shopifyBulkOperationId
      );

    if (!shopifyBulkOperationId) {
      skipped += 1;
      continue;
    }

    logger.info("Recovering stuck bulk mutation", {
      worker: "stuckBulkMutationRecoveryWorker",
      historyId: history.id,
      shop: history.shop,
      shopifyBulkOperationId,
      mode: isUndo ? "undo" : "edit",
    });

    try {
      const recoveryCooldownKey = buildRecoveryCooldownKey({
        shop: history.shop,
        shopifyBulkOperationId,
        mode: isUndo ? "undo" : "edit",
      });
      const cooldownClaimed = await connection.set(
        recoveryCooldownKey,
        String(Date.now()),
        "NX",
        "PX",
        RECOVERY_COOLDOWN_MS,
      );
      if (cooldownClaimed !== "OK") {
        skipped += 1;
        continue;
      }

      if (isUndo) {
        await addbulkUndoResultIngestJob({
          shop: history.shop,
          shopifyBulkOperationId,
          source: "stuck_bulk_mutation_recovery",
        });
      } else {
        await addbulkEditResultIngestJob(
          {
            shop: history.shop,
            shopifyBulkOperationId,
            executionId: history.executionIdentity || null,
            source: "stuck_bulk_mutation_recovery",
          },
          {
            // A retained completed job with the default deterministic ID would
            // prevent BullMQ from running this recovery attempt.
            jobId: joinSafeJobId(
              "stuck-bulk-edit-result-ingest",
              history.shop,
              history.id,
              Math.floor(Date.now() / RECOVERY_COOLDOWN_MS),
            ),
          },
        );
      }

      recovered += 1;
    } catch (error) {
      skipped += 1;

      logger.error("Failed to recover stuck bulk mutation", {
        worker: "stuckBulkMutationRecoveryWorker",
        historyId: history.id,
        shop: history.shop,
        shopifyBulkOperationId,
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
    await enqueueStuckBulkMutationRecoveryJob();
  } catch (error) {
    logger.error("Failed to enqueue stuck bulk mutation recovery job", {
      worker: "stuckBulkMutationRecoveryWorker",
      message: error.message,
    });
  }
}

async function registerRepeatableTick() {
  const leaderLock = await acquireRedisLock({
    connection,
    key: LEADER_LOCK_KEY,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueStuckBulkMutationRecoveryTick(POLL_INTERVAL_MS);
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

await registerRepeatableTick();
