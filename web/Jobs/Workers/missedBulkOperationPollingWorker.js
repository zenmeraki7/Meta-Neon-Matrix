import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { prisma } from "../../config/database.js";
import shopify from "../../shopify.js";
import logger from "../../utils/loggerUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "../Queues/bulkUndoResultIngestJob.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "missed-bulk-operation-polling";
const POLL_COOLDOWN_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 60_000;
const LEADER_LOCK_KEY = "leader:missed-bulk-operation-polling:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;

const BULK_OPERATION_RESULT_QUERY = `#graphql
  query BulkOperationResult($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        type
        url
        partialDataUrl
      }
    }
  }
`;

function buildPollCooldownKey(shop, bulkOperationId) {
  return `missed-webhook-poll:${shop}:${bulkOperationId}`;
}

async function fetchBulkOperationStatus({ shop, bulkOperationId }) {
  const session = await getSession(shop);
  if (!session?.shop || session.shop !== shop) {
    throw new Error("Shop session not available for missed-webhook polling");
  }

  const client = new shopify.api.clients.Graphql({ session });
  const response = await client.query({
    data: {
      query: BULK_OPERATION_RESULT_QUERY,
      variables: { id: bulkOperationId },
    },
  });

  const node = response?.body?.data?.node || null;
  return {
    id: node?.id || null,
    status: String(node?.status || "").toUpperCase(),
    type: String(node?.type || "").toUpperCase(),
    url: node?.url || null,
    partialDataUrl: node?.partialDataUrl || null,
  };
}

function isTerminalStatus(status) {
  return ["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(
    String(status || "").toUpperCase(),
  );
}

async function pollMissedBulkOperations() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000);

  const candidates = await prisma.editHistory.findMany({
    where: {
      OR: [
        {
          executionState: {
            in: [
              OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
              OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
            ],
          },
          updatedAt: { lt: cutoff },
          batch: {
            path: ["resultIngestion", "ingestedAt"],
            equals: null,
          },
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
      executionIdentity: true,
      bulkOperationId: true,
      batch: true,
      undo: true,
    },
    take: 50,
    orderBy: { updatedAt: "asc" },
  });

  let scanned = 0;
  let enqueued = 0;
  let skipped = 0;

  for (const history of candidates) {
    scanned += 1;
    const undo = history.undo || {};
    const isUndo =
      undo?.status === "processing"
      && undo?.state === "awaiting_shopify"
      && undo?.bulkOperationId;

    const bulkOperationId = isUndo
      ? String(undo.bulkOperationId)
      : String(
        history.batch?.shopifyBulkOperation?.id
          || history.batch?.shopifyBulkOperationId
          || history.bulkOperationId
          || "",
      );

    if (!bulkOperationId) {
      skipped += 1;
      continue;
    }

    const cooldownKey = buildPollCooldownKey(history.shop, bulkOperationId);
    const claimed = await connection.set(cooldownKey, String(Date.now()), "NX", "PX", POLL_COOLDOWN_MS);
    if (claimed !== "OK") {
      skipped += 1;
      continue;
    }

    try {
      const op = await fetchBulkOperationStatus({
        shop: history.shop,
        bulkOperationId,
      });

      if (!isTerminalStatus(op.status)) {
        skipped += 1;
        continue;
      }

      if (isUndo) {
        await addbulkUndoResultIngestJob({
          shop: history.shop,
          bulkOperationId,
          source: "missed_webhook_polling",
        });
      } else {
        await addbulkEditResultIngestJob({
          shop: history.shop,
          bulkOperationId,
          executionId: history.executionIdentity || null,
          source: "missed_webhook_polling",
        });
      }
      enqueued += 1;
    } catch (error) {
      skipped += 1;
      logger.error("Missed webhook polling failed", {
        worker: "missedBulkOperationPollingWorker",
        historyId: history.id,
        shop: history.shop,
        bulkOperationId,
        message: error?.message || String(error),
      });
    }
  }

  return { scanned, enqueued, skipped };
}

export const missedBulkOperationPollingQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

export const missedBulkOperationPollingWorker = new Worker(
  QUEUE_NAME,
  async () => pollMissedBulkOperations(),
  {
    connection,
    concurrency: 1,
  },
);

missedBulkOperationPollingWorker.on("completed", (job, result) => {
  logger.info("Missed bulk operation polling completed", {
    worker: "missedBulkOperationPollingWorker",
    jobId: job?.id,
    result,
  });
});

missedBulkOperationPollingWorker.on("failed", (job, error) => {
  logger.error("Missed bulk operation polling failed", {
    worker: "missedBulkOperationPollingWorker",
    jobId: job?.id,
    message: error?.message || String(error),
  });
});

async function enqueuePollingJob() {
  try {
    await missedBulkOperationPollingQueue.add(
      "poll-missed-bulk-operations",
      {},
      { jobId: "poll-missed-bulk-operations" },
    );
  } catch (error) {
    logger.error("Failed to enqueue missed bulk operation polling job", {
      worker: "missedBulkOperationPollingWorker",
      message: error?.message || String(error),
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
    await missedBulkOperationPollingQueue.add(
      "poll-missed-bulk-operations",
      {},
      {
        jobId: "poll-missed-bulk-operations",
        repeat: { every: POLL_INTERVAL_MS },
      },
    );
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

await registerRepeatableTick();
