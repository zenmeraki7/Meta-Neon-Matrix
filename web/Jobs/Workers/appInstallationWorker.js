import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { getShopOwnerEmailAddress, getSession } from "../../utils/sessionHandler.js";
import { Services } from "../../services/productService/productFilterService.js";
import {
  confirmShopInstallation,
  sentInstalledMailToAdmin,
  sentWelcomeMailToStore,
} from "../../middleware/appInstallMiddleware.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import {
  acquireRedisLock,
  releaseRedisLock,
  renewRedisLock,
} from "../../utils/redisLockUtils.js";
import {
  enqueueAutomaticProductRuleSchedulerTick,
  enqueueCatalogMissedUpdatesPollingTick,
  enqueueMissedBulkOperationPollingTick,
  enqueueOperationEnqueueIntentRecoveryTick,
  enqueueOutboxDispatcherSchedulerTick,
  enqueueResultFileExpiryCheckTick,
  enqueueRecurringEditSchedulerTick,
  enqueueScheduledEditRecoveryTick,
  enqueueScheduledExportSchedulerTick,
  enqueueStuckBulkMutationRecoveryTick,
  enqueueUnresolvedBulkOperationRecoveryTick,
} from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import { scheduleReconciliationJob } from "../Queues/reconciliationJob.js";

const QUEUE_NAME = process.env.APP_INSTALLATION_QUEUE || "app-installation";
const INSTALLATION_LOCK_TTL_MS = 5 * 60 * 1000;
const productService = new Services();

async function acquireInstallationLock(shop) {
  return acquireRedisLock({
    connection,
    key: `lock:app_installation:${String(shop).replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    ttlMs: INSTALLATION_LOCK_TTL_MS,
  });
}

async function registerShopRepeatableJobs({ shop, jobId }) {
  const results = await Promise.allSettled([
    enqueueAutomaticProductRuleSchedulerTick({
      shop,
      repeatEveryMs: Number(process.env.AUTOMATIC_PRODUCT_RULE_SCHEDULER_INTERVAL_MS || 60_000),
    }),
    enqueueRecurringEditSchedulerTick({
      shop,
      repeatEveryMs: Number(process.env.RECURRING_EDIT_SCHEDULER_INTERVAL_MS || 60_000),
    }),
    enqueueScheduledExportSchedulerTick({
      shop,
      repeatEveryMs: Number(process.env.SCHEDULED_EXPORT_SCHEDULER_INTERVAL_MS || 10_000),
    }),
    enqueueOperationEnqueueIntentRecoveryTick({
      shop,
      repeatEveryMs: 60_000,
    }),
    enqueueMissedBulkOperationPollingTick({
      shop,
      repeatEveryMs: 60_000,
    }),
    enqueueCatalogMissedUpdatesPollingTick({
      queueName: process.env.CATALOG_MISSED_UPDATES_POLL_QUEUE || "catalog-missed-updates-polling",
      shop,
      repeatEveryMs: 15 * 60 * 1000,
    }),
    enqueueScheduledEditRecoveryTick({
      shop,
      repeatEveryMs: 60_000,
    }),
    enqueueUnresolvedBulkOperationRecoveryTick({
      shop,
      repeatEveryMs: 60_000,
    }),
    enqueueResultFileExpiryCheckTick({
      shop,
      repeatEveryMs: 60 * 60 * 1000,
    }),
    enqueueStuckBulkMutationRecoveryTick({
      shop,
      repeatEveryMs: 60_000,
    }),
    enqueueOutboxDispatcherSchedulerTick({
      queueName: "outbox-dispatcher-scheduler",
      shop,
      repeatEveryMs: Number.parseInt(process.env.OUTBOX_DISPATCHER_POLL_INTERVAL_MS || "5000", 10),
    }),
    scheduleReconciliationJob({ shop }),
  ]);
  const failures = results
    .map((result, index) => (
      result.status === "rejected"
        ? {
            index,
            reason: result.reason?.message || String(result.reason),
            error: result.reason,
          }
        : null
    ))
    .filter(Boolean);
  if (failures.length > 0) {
    logger.error("Scheduler registration partially failed", {
      worker: "appInstallationWorker",
      shop,
      jobId,
      failures: failures.map(({ index, reason }) => ({ index, reason })),
    });
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Failed to register ${failures.length} repeatable jobs`,
    );
  }
}

async function assertCurrentInstallation(shop, installationGeneration) {
  const store = await db.store.findFirst({
    where: {
      shopUrl: shop,
      installationGeneration,
      isUnInstalled: false,
      installationStatus: "processing",
    },
    select: {
      installationStatus: true,
      installationSetupCompletedAt: true,
    },
  });
  return store;
}

async function claimOrResumeInstallation(shop, installationGeneration) {
  const claim = await db.store.updateMany({
    where: {
      shopUrl: shop,
      installationGeneration,
      installationStatus: { in: ["pending", "processing"] },
      isUnInstalled: false,
    },
    data: {
      installationStatus: "processing",
      installationProcessingStartedAt: new Date(),
      unInstalledAt: null,
    },
  });
  if (claim.count > 0) {
    return { installationStatus: "processing", installationSetupCompletedAt: null };
  }

  return db.store.findFirst({
    where: {
      shopUrl: shop,
      installationGeneration,
      isUnInstalled: false,
    },
    select: {
      installationStatus: true,
      installationSetupCompletedAt: true,
    },
  });
}

async function markInstallationSetupCompleted(shop, installationGeneration) {
  const result = await db.store.updateMany({
    where: {
      shopUrl: shop,
      installationGeneration,
      isUnInstalled: false,
      installationStatus: "processing",
      installationSetupCompletedAt: null,
    },
    data: {
      installationStatus: "complete",
      installationProcessingStartedAt: null,
      installationSetupCompletedAt: new Date(),
      installedAt: new Date(),
    },
  });
  return result.count > 0;
}

const appInstallationWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const payloadVersion = job.data?.version;
    const shop = job.data?.shop;
    const installationGeneration = job.data?.installationGeneration;
    if (payloadVersion !== 1) {
      logger.warn("Unsupported app installation payload version, discarding", {
        worker: "appInstallationWorker",
        jobId: job.id,
        payloadVersion,
      });
      return { skipped: true, reason: "unsupported_payload_version" };
    }
    if (!shop) {
      throw new Error("app-installation job requires shop");
    }
    if (!installationGeneration) {
      throw new Error("app-installation job requires installationGeneration");
    }

    const lock = await acquireInstallationLock(shop);
    if (!lock.acquired) {
      const error = new Error(`app-installation already active for shop: ${shop}`);
      error.code = "APP_INSTALLATION_LOCKED";
      throw error;
    }
    const lockRenewalTimer = setInterval(async () => {
      const renewed = await renewRedisLock({
        connection,
        key: lock.key,
        token: lock.token,
        ttlMs: INSTALLATION_LOCK_TTL_MS,
      }).catch(() => false);
      if (!renewed) {
        logger.error("App installation lock renewal failed", {
          worker: "appInstallationWorker",
          jobId: job.id,
          shop,
        });
      }
    }, Math.floor(INSTALLATION_LOCK_TTL_MS / 3));
    lockRenewalTimer.unref?.();

    try {
      const installation = await claimOrResumeInstallation(shop, installationGeneration);
      if (
        !installation
        || installation.installationStatus === "complete"
        || installation.installationSetupCompletedAt
      ) {
        const reason = installation ? "already_complete" : "superseded";
        logger.warn("App installation superseded or already completed, discarding", {
          worker: "appInstallationWorker",
          jobId: job.id,
          shop,
          installationGeneration,
          reason,
          attemptsMade: job.attemptsMade,
        });
        return {
          skipped: true,
          reason,
          shop,
        };
      }

      // Always resolve from secure session store - never accept token from payload.
      const session = await getSession(shop);
      if (!session?.accessToken) {
        throw new Error(`app-installation session missing or invalid for shop: ${shop}`);
      }

      const { email, shopOwner } = await getShopOwnerEmailAddress(session);
      await confirmShopInstallation({
        session,
        email,
        shop,
        accessToken: session.accessToken,
        installationGeneration,
      });

      if (!await assertCurrentInstallation(shop, installationGeneration)) {
        return { skipped: true, reason: "superseded", shop };
      }

      await registerShopRepeatableJobs({ shop, jobId: job.id });

      const countResponse = await adminGraphqlWithRetry({
        session,
        shop,
        operationName: "productsCount",
        data: {
          query: `
            query {
              productsCount {
                count
              }
            }
          `,
        },
      });

      const count = countResponse?.body?.data?.productsCount?.count || 0;

      const [store, mirroredProductCount, latestCompletedSync] = await Promise.all([
        db.store.findUnique({
          where: { shopUrl: shop },
          select: {
            shopifyBulkJobCompleted: true,
          },
        }),
        db.product.count({
          where: { shop },
        }),
        db.syncHistory.findFirst({
          where: {
            shop,
            operationType: "Product",
            status: "completed",
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        }),
      ]);

      const shouldStartInitialSync =
        !store ||
        mirroredProductCount === 0 ||
        !latestCompletedSync ||
        store.shopifyBulkJobCompleted !== true;
      let startedInitialSync = false;

      if (shouldStartInitialSync) {
        const currentBulkOperation = await getCurrentBulkOperationStatus(session, "QUERY");
        if (["CREATED", "RUNNING", "CANCELING"].includes(currentBulkOperation?.status)) {
          const matchingProductSync = currentBulkOperation?.id
            ? await db.syncHistory.findFirst({
                where: {
                  shop,
                  bulkOperationId: currentBulkOperation.id,
                  operationType: "Product",
                  status: "processing",
                },
                select: { id: true },
              })
            : null;
          if (!matchingProductSync) {
            const error = new Error("INITIAL_PRODUCT_SYNC_BULK_OPERATION_ALREADY_ACTIVE");
            error.code = "INITIAL_PRODUCT_SYNC_BULK_OPERATION_ALREADY_ACTIVE";
            throw error;
          }
        }

        if (!await assertCurrentInstallation(shop, installationGeneration)) {
          return { skipped: true, reason: "superseded", shop };
        }

        if (!["CREATED", "RUNNING", "CANCELING"].includes(currentBulkOperation?.status)) {
          await productService.startBulkOperationToFetchProducts({
            session,
            isInitialSync: true,
          });
          startedInitialSync = true;
        }

        await db.store.updateMany({
          where: {
            shopUrl: shop,
            installationGeneration,
            isUnInstalled: false,
          },
          data: {
            storeTotalProducts: count,
            isProductInitialySyning: true,
            shopifyBulkJobCompleted: false,
          },
        });
      } else {
        await db.store.updateMany({
          where: {
            shopUrl: shop,
            installationGeneration,
            isUnInstalled: false,
          },
          data: {
            storeTotalProducts: count,
            isProductInitialySyning: false,
          },
        });
      }

      if (!await assertCurrentInstallation(shop, installationGeneration)) {
        return { skipped: true, reason: "superseded", shop };
      }

      const completed = await markInstallationSetupCompleted(shop, installationGeneration);
      if (!completed) {
        logger.warn("Installation superseded before completion, discarding", {
          worker: "appInstallationWorker",
          jobId: job.id,
          shop,
          installationGeneration,
        });
        return { skipped: true, reason: "superseded", shop };
      }

      await Promise.allSettled([
        sentWelcomeMailToStore({ email, shopOwner, shop }),
        sentInstalledMailToAdmin({ email, shop }),
      ]);

      logger.info("App installation background job completed", {
        worker: "appInstallationWorker",
        jobId: job.id,
        shop,
        startedInitialSync,
      });

      return {
        success: true,
        shop,
        startedInitialSync,
      };
    } catch (error) {
      if (error?.message === "STALE_INSTALLATION_GENERATION") {
        logger.warn("Installation superseded during setup, discarding", {
          worker: "appInstallationWorker",
          jobId: job.id,
          shop,
          installationGeneration,
        });
        return { skipped: true, reason: "superseded", shop };
      }
      await logWorkerError({
        shop,
        err: error,
        source: "AppInstallationWorker",
      });
      throw error;
    } finally {
      clearInterval(lockRenewalTimer);
      await releaseRedisLock({
        connection,
        key: lock.key,
        token: lock.token,
      }).catch(() => {});
    }
  },
  {
    connection,
    concurrency: 3,
    stalledInterval: Number(process.env.APP_INSTALLATION_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.APP_INSTALLATION_MAX_STALLED_COUNT || 2),
  },
);

appInstallationWorker.on("failed", (job, error) => {
  logger.error("App installation worker failed", {
    worker: "appInstallationWorker",
    jobId: job?.id,
    shop: job?.data?.shop,
    message: error.message,
  });
});

export default appInstallationWorker;
