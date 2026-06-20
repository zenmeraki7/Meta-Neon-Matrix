// web/Jobs/Workers/bulkEditItemApplyWorker.js

import { QueueEvents, Worker } from "bullmq";
import shopify from "../../shopify.js";
import {
  connection as redisConnection,
  createRedisConnection,
} from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import {
  bulkEditItemApplyDlqQueue,
} from "../../queues/adapters/jobsQueueInstancesAdapter.js";

/**
 * You need to implement/map these repository methods to your existing DB layer.
 */
import {
  findBulkEditItemForApply,
  markBulkEditItemApplying,
  markBulkEditItemDone,
  markBulkEditItemFailed,
  markBulkEditItemDeferred,
  incrementBulkEditParentCounters,
} from "../../repositories/bulkEditItemApplyRepository.js";

const WORKER_NAME = "bulkEditItemApplyWorker";

const QUEUE_NAME =
  process.env.BULK_EDIT_ITEM_APPLY_QUEUE || "bulk-edit-item-apply";

const WORKER_CONCURRENCY = Number.parseInt(
  process.env.BULK_EDIT_ITEM_APPLY_WORKER_CONCURRENCY || "4",
  10,
);

const WORKER_LIMIT_MAX = Number.parseInt(
  process.env.BULK_EDIT_ITEM_APPLY_LIMIT_MAX || "4",
  10,
);

const WORKER_LIMIT_DURATION_MS = Number.parseInt(
  process.env.BULK_EDIT_ITEM_APPLY_LIMIT_DURATION_MS || "1000",
  10,
);

const LONG_RETRY_AFTER_MS = Number.parseInt(
  process.env.BULK_EDIT_ITEM_LONG_RETRY_AFTER_MS || "300000",
  10,
);

const METAFIELDS_SET_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        owner {
          ... on Product { id }
          ... on ProductVariant { id }
          ... on Collection { id }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function getMaxAttempts(job) {
  return Number(job?.opts?.attempts || 1);
}

function willExhaustRetry(job) {
  return Number(job?.attemptsMade || 0) + 1 >= getMaxAttempts(job);
}

function safeMessage(error) {
  return String(error?.message || error || "Unknown error").slice(0, 1000);
}

function parseRetryAfterMs(error) {
  const retryAfter =
    error?.response?.headers?.["retry-after"] ||
    error?.response?.headers?.get?.("retry-after") ||
    error?.retryAfter;

  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return seconds * 1000;

  const dateMs = Date.parse(String(retryAfter));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

function isRetryableError(error) {
  if (error?.nonRetryable === true) return false;
  if (error?.retryable === true) return true;

  const message = safeMessage(error);
  const status = error?.response?.status || error?.statusCode || error?.status;

  return (
    status === 429 ||
    status >= 500 ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ENOTFOUND") ||
    message.includes("ECONNREFUSED") ||
    message.includes("RETRYABLE") ||
    message.includes("THROTTLED")
  );
}

function assertPayload(job) {
  const data = job.data || {};

  const bulkJobId = String(data.bulkJobId || "").trim();
  const itemId = String(data.itemId || "").trim();
  const shop = String(data.shop || "").trim();
  const ownerId = String(data.ownerId || "").trim();
  const namespace = String(data.namespace || "").trim();
  const key = String(data.key || "").trim();
  const type = String(data.type || "").trim();

  if (!bulkJobId) throw new Error("bulkJobId is required");
  if (!itemId) throw new Error("itemId is required");
  if (!shop) throw new Error("shop is required");
  if (!ownerId) throw new Error("ownerId is required");
  if (!namespace) throw new Error("namespace is required");
  if (!key) throw new Error("key is required");
  if (!type) throw new Error("type is required");

  return {
    bulkJobId,
    itemId,
    shop,
    ownerId,
    namespace,
    key,
    type,
    value: data.value,
  };
}

async function buildSessionForShop(shop) {
  const offlineSessionId = shopify.api.session.getOfflineId(shop);
  const session = await shopify.config.sessionStorage.loadSession(offlineSessionId);

  const normalize = (v) => String(v || "").toLowerCase().replace(/\/$/, "");

  if (!session?.accessToken || normalize(session.shop) !== normalize(shop)) {
    const error = new Error("OFFLINE_SESSION_NOT_FOUND_OR_MISMATCHED");
    error.nonRetryable = true;
    throw error;
  }

  return session;
}

async function applyMetafield({ client, ownerId, namespace, key, type, value }) {
  const response = await client.request(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId,
          namespace,
          key,
          type,
          value: String(value ?? ""),
        },
      ],
    },
  });

  const topLevelErrors = response?.errors || response?.body?.errors;
  if (topLevelErrors?.length) {
    const error = new Error(topLevelErrors[0]?.message || "SHOPIFY_GRAPHQL_ERROR");
    error.retryable = true;
    throw error;
  }

  const payload =
    response?.data?.metafieldsSet ||
    response?.body?.data?.metafieldsSet;

  const userErrors = payload?.userErrors || [];

  if (userErrors.length) {
    const error = new Error(userErrors[0]?.message || "SHOPIFY_USER_ERROR");
    error.nonRetryable = true;
    error.userErrors = userErrors;
    throw error;
  }

  return payload?.metafields?.[0] || null;
}

async function processBulkEditItemApplyJob(job) {
  const payload = assertPayload(job);
  const { bulkJobId, itemId, shop } = payload;

  try {
    await job.updateProgress({ stage: "loading_item", pct: 10 });

    const item = await findBulkEditItemForApply({
      bulkJobId,
      itemId,
      shop,
    });

    if (!item) {
      const error = new Error("BULK_EDIT_ITEM_NOT_FOUND");
      error.nonRetryable = true;
      throw error;
    }

    if (item.status === "DONE") {
      return {
        success: true,
        skipped: true,
        reason: "ITEM_ALREADY_DONE",
        bulkJobId,
        itemId,
      };
    }

    if (item.status === "CANCELLED") {
      return {
        success: true,
        skipped: true,
        reason: "ITEM_CANCELLED",
        bulkJobId,
        itemId,
      };
    }

    await markBulkEditItemApplying({
      bulkJobId,
      itemId,
      shop,
      attempt: Number(job.attemptsMade || 0) + 1,
    });

    await job.updateProgress({ stage: "building_session", pct: 25 });

    const session = await buildSessionForShop(shop);
    const client = new shopify.api.clients.Graphql({ session });

    await job.updateProgress({ stage: "applying_metafield", pct: 60 });

    const appliedMetafield = await applyMetafield({
      client,
      ownerId: payload.ownerId,
      namespace: payload.namespace,
      key: payload.key,
      type: payload.type,
      value: payload.value,
    });

    await markBulkEditItemDone({
      bulkJobId,
      itemId,
      shop,
      shopifyMetafieldId: appliedMetafield?.id || null,
    });

    await incrementBulkEditParentCounters({
      bulkJobId,
      shop,
      completedDelta: 1,
    });

    await job.updateProgress({ stage: "done", pct: 100 });

    return {
      success: true,
      done: true,
      bulkJobId,
      itemId,
      shopifyMetafieldId: appliedMetafield?.id || null,
    };
  } catch (error) {
    const retryAfterMs = parseRetryAfterMs(error);

    if (retryAfterMs && retryAfterMs > LONG_RETRY_AFTER_MS) {
      await markBulkEditItemDeferred({
        bulkJobId,
        itemId,
        shop,
        reason: "LONG_RETRY_AFTER",
        retryAfterMs,
        message: safeMessage(error),
      });

      await incrementBulkEditParentCounters({
        bulkJobId,
        shop,
        deferredDelta: 1,
      });

      return {
        success: true,
        deferred: true,
        retryAfterMs,
        bulkJobId,
        itemId,
      };
    }

    const retryable = isRetryableError(error);
    const terminal = !retryable || willExhaustRetry(job);

    if (terminal) {
      await markBulkEditItemFailed({
        bulkJobId,
        itemId,
        shop,
        reason: error?.nonRetryable ? "NON_RETRYABLE" : "RETRIES_EXHAUSTED",
        message: safeMessage(error),
        userErrors: error?.userErrors || null,
      });

      await incrementBulkEditParentCounters({
        bulkJobId,
        shop,
        failedDelta: 1,
      });
    }

    throw error;
  }
}

export const bulkEditItemApplyWorker = new Worker(
  QUEUE_NAME,
  processBulkEditItemApplyJob,
  {
    connection: redisConnection,
    concurrency: Number.isFinite(WORKER_CONCURRENCY) ? WORKER_CONCURRENCY : 4,
    autorun: false,
    lockDuration: Number(
      process.env.BULK_EDIT_ITEM_APPLY_LOCK_DURATION_MS || 300000,
    ),
    stalledInterval: Number(
      process.env.BULK_EDIT_ITEM_APPLY_STALLED_INTERVAL_MS || 60000,
    ),
    maxStalledCount: Number(
      process.env.BULK_EDIT_ITEM_APPLY_MAX_STALLED_COUNT || 2,
    ),
    limiter: {
      max: Number.isFinite(WORKER_LIMIT_MAX) ? WORKER_LIMIT_MAX : 4,
      duration: Number.isFinite(WORKER_LIMIT_DURATION_MS)
        ? WORKER_LIMIT_DURATION_MS
        : 1000,
    },
  },
);

const bulkEditItemApplyQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection(),
});

bulkEditItemApplyQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Bulk edit item apply queue event failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
    failedReason,
  });
});

bulkEditItemApplyQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Bulk edit item apply queue event stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkEditItemApplyWorker.on("completed", (job, result) => {
  logger.info("Bulk edit item apply worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job.id,
    bulkJobId: job.data?.bulkJobId,
    itemId: job.data?.itemId,
    shop: job.data?.shop,
    success: Boolean(result?.success),
    done: Boolean(result?.done),
    skipped: Boolean(result?.skipped),
    deferred: Boolean(result?.deferred),
    reason: result?.reason || null,
  });
});

bulkEditItemApplyWorker.on("failed", (job, error) => {
  const maxAttempts = Number(job?.opts?.attempts || 1);
  const attemptsMade = Number(job?.attemptsMade || 0);

  if (attemptsMade >= maxAttempts) {
    void bulkEditItemApplyDlqQueue.add(
      "bulk-edit-item-apply-dlq",
      {
        originalQueue: QUEUE_NAME,
        originalJobId: job?.id,
        originalJobName: job?.name,
        data: job?.data,
        failedReason: safeMessage(error),
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq:${QUEUE_NAME}:${job?.id}`,
        removeOnComplete: { age: 604800, count: 5000 },
      },
    ).catch((dlqErr) => {
      logger.error("Bulk edit item apply DLQ enqueue failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        originalJobId: job?.id,
        message: safeMessage(dlqErr),
        stack: dlqErr?.stack,
      });
    });
  }

  logger.error("Bulk edit item apply worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    bulkJobId: job?.data?.bulkJobId,
    itemId: job?.data?.itemId,
    shop: job?.data?.shop,
    attemptsMade,
    maxAttempts,
    message: safeMessage(error),
    stack: error?.stack,
  });
});

bulkEditItemApplyWorker.on("error", (error) => {
  logger.error("Bulk edit item apply worker runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: safeMessage(error),
    stack: error?.stack,
  });
});

export function startBulkEditItemApplyWorker() {
  if (
    !startBulkEditItemApplyWorker.started &&
    !bulkEditItemApplyWorker.isRunning()
  ) {
    startBulkEditItemApplyWorker.started = true;
    bulkEditItemApplyWorker.run();

    logger.info("Bulk edit item apply worker started", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      concurrency: Number.isFinite(WORKER_CONCURRENCY)
        ? WORKER_CONCURRENCY
        : 4,
    });
  }

  return bulkEditItemApplyWorker;
}

startBulkEditItemApplyWorker.started = false;

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Closing bulk edit item apply worker", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    signal,
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("BULK_EDIT_ITEM_APPLY_WORKER_CLOSE_TIMEOUT")),
      25_000,
    ),
  );

  try {
    await Promise.race([
      (async () => {
        await bulkEditItemApplyWorker.close();
        await bulkEditItemApplyQueueEvents.close();
      })(),
      timeout,
    ]);
  } catch (error) {
    logger.error("Bulk edit item apply worker shutdown failed", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      message: safeMessage(error),
      stack: error?.stack,
    });

    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkEditItemApplyWorker;