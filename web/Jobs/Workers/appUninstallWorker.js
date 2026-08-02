import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { sendEmail } from "../../utils/emailHelper.js";
import { uninstallFeedbackHTML } from "../../config/templates/uninstallTemplate.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { executeShopRedaction } from "../../services/shopRedactionService.js";
import { logWebhookError } from "../../utils/errorLogUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { logStoreMutation } from "../../repositories/storeRepository.js";
import logger from "../../utils/loggerUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import shopify from "../../shopify.js";
import {
  appInstallationQueue,
  bulkEditExecuteQueue,
  bulkEditPipelineQueue,
  bulkEditResultIngestQueue,
  bulkExportQueue,
  bulkImportEditQueue,
  bulkOperationMutationQueue,
  bulkOperationQueryQueue,
  bulkUndoQueue,
  bulkUndoResultIngestQueue,
  productCreateQueue,
  productUpdateQueue,
  productDeleteQueue,
  productSyncClearProductTypesQueue,
  productSyncExecuteQueue,
  productSyncSchedulerQueue,
  scheduledEditQueue,
  shopSyncQueue,
  subscriptionBillingQueue,
  targetFreezeQueue,
} from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const QUEUE_NAME = "appUninstall";
const ACTIVE_DRAIN_TIMEOUT_MS = 30_000;
const ACTIVE_DRAIN_POLL_MS = 1_000;
const SHOP_SCOPED_QUEUES = [
  appInstallationQueue,
  bulkEditExecuteQueue,
  bulkEditPipelineQueue,
  bulkEditResultIngestQueue,
  bulkExportQueue,
  bulkImportEditQueue,
  bulkOperationMutationQueue,
  bulkOperationQueryQueue,
  bulkUndoQueue,
  bulkUndoResultIngestQueue,
  productCreateQueue,
  productUpdateQueue,
  productDeleteQueue,
  productSyncClearProductTypesQueue,
  productSyncExecuteQueue,
  productSyncSchedulerQueue,
  scheduledEditQueue,
  shopSyncQueue,
  subscriptionBillingQueue,
  targetFreezeQueue,
];

function jobBelongsToShop(job, shop) {
  if (!job?.data || !shop) return false;
  return (
    job.data.shop === shop
    || job.data.shopUrl === shop
    || job.data.domain === shop
  );
}

async function cancelPendingJobsForShop(shop) {
  for (const queue of SHOP_SCOPED_QUEUES) {
    // eslint-disable-next-line no-await-in-loop
    const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 1000);
    for (const job of jobs) {
      if (jobBelongsToShop(job, shop)) {
        // eslint-disable-next-line no-await-in-loop
        await job.remove().catch(() => {});
      }
    }
  }
}

async function removeQueuedProductSyncJobsForShop(shopUrl) {
  const states = ["waiting", "delayed", "paused", "prioritized"];
  for (const queue of [productSyncExecuteQueue, productSyncSchedulerQueue]) {
    // eslint-disable-next-line no-await-in-loop
    const jobs = await queue.getJobs(states, 0, 5000);
    for (const job of jobs) {
      if (jobBelongsToShop(job, shopUrl)) {
        // eslint-disable-next-line no-await-in-loop
        await job.remove().catch(() => {});
      }
    }
  }
}

async function removeRepeatableProductSyncJobs() {
  const repeatables = await productSyncSchedulerQueue.getRepeatableJobs().catch(() => []);
  for (const repeatable of repeatables) {
    if (repeatable?.name === "auto-sync" || repeatable?.name === "priority-sync") {
      // eslint-disable-next-line no-await-in-loop
      await productSyncSchedulerQueue.removeRepeatableByKey(repeatable.key).catch(() => {});
    }
  }
}

async function waitForActiveJobsToDrain(shop) {
  const deadline = Date.now() + ACTIVE_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let hasActive = false;
    for (const queue of SHOP_SCOPED_QUEUES) {
      // eslint-disable-next-line no-await-in-loop
      const active = await queue.getJobs(["active"], 0, 200);
      if (active.some((job) => jobBelongsToShop(job, shop))) {
        hasActive = true;
        break;
      }
    }
    if (!hasActive) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, ACTIVE_DRAIN_POLL_MS));
  }
}

async function releaseShopRedisKeys(shop) {
  const patterns = [
    `shop-exclusive-work:*:${shop}`,
    `scheduled-run-lock:${shop}:*`,
    `lock:product_sync:${shop}`,
    `missed-webhook-poll:${shop}:*`,
    `stuck-recovery-cooldown:${shop}:*`,
    `shop-sync:${shop}:*`,
  ];
  for (const pattern of patterns) {
    // eslint-disable-next-line no-await-in-loop
    const keys = await connection.keys(pattern).catch(() => []);
    if (Array.isArray(keys) && keys.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await connection.del(keys).catch(() => {});
    }
  }
}

const CURRENT_BULK_QUERY = `#graphql
  query CurrentBulk {
    currentBulkOperation(type: QUERY) {
      id
      status
    }
  }
`;

const CURRENT_BULK_MUTATION = `#graphql
  query CurrentBulk {
    currentBulkOperation(type: MUTATION) {
      id
      status
    }
  }
`;

const BULK_CANCEL_MUTATION = `#graphql
  mutation CancelBulk($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

async function cancelActiveShopifyBulkOps(shop) {
  const session = await getSession(shop).catch(() => null);
  if (!session?.shop || session.shop !== shop) return;
  const client = new shopify.api.clients.Graphql({ session });
  const [queryOp, mutationOp] = await Promise.all([
    client.query({ data: { query: CURRENT_BULK_QUERY } }).catch(() => null),
    client.query({ data: { query: CURRENT_BULK_MUTATION } }).catch(() => null),
  ]);
  const candidates = [
    queryOp?.body?.data?.currentBulkOperation?.id,
    mutationOp?.body?.data?.currentBulkOperation?.id,
  ].filter(Boolean);
  for (const id of candidates) {
    // eslint-disable-next-line no-await-in-loop
    await client.query({
      data: {
        query: BULK_CANCEL_MUTATION,
        variables: { id },
      },
    }).catch(() => {});
  }
}

const appUninstallWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    if (!shop) {
      throw new Error("app-uninstall job requires shop");
    }

    try {
      const store = await db.store.findUnique({
        where: { shopUrl: shop },
        select: {
          shopEmail: true,
          installationStatus: true,
        },
      });

      if (!store) {
        return {
          skipped: true,
          reason: "store_not_found",
          shop,
        };
      }

      if (store.installationStatus === "UNINSTALLED") {
        return {
          skipped: true,
          reason: "already_uninstalled",
          shop,
        };
      }

      await cancelPendingJobsForShop(shop);
      await removeQueuedProductSyncJobsForShop(shop);
      await removeRepeatableProductSyncJobs();
      await waitForActiveJobsToDrain(shop);
      await releaseShopRedisKeys(shop);
      await cancelActiveShopifyBulkOps(shop).catch(() => {});

      await executeShopRedaction({
        shop,
        topic: "APP_UNINSTALLED",
        webhookId: job.data?.webhookId,
      });

      if (store.shopEmail) {
        await sendEmail(
          store.shopEmail,
          "Your feedback would mean the world to us",
          uninstallFeedbackHTML("Metamatrix User", shop, shop.split(".")[0]),
          true,
        );
      }

      await clearKeyCaches(`${shop}`);

      logger.info("App uninstall background job completed", {
        worker: "appUninstallWorker",
        jobId: job.id,
        shop,
      });

      return {
        success: true,
        shop,
      };
    } catch (error) {
      await logWebhookError({
        shop,
        err: error,
        source: "appUninstallWorker",
        req: job.data,
      });
      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
  },
);

appUninstallWorker.on("failed", (job, error) => {
  logger.error("App uninstall worker failed", {
    worker: "appUninstallWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    message: error.message,
  });
});

export default appUninstallWorker;
