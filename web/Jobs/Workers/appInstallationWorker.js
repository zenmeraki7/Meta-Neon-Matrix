import { Worker } from "bullmq";
import crypto from "node:crypto";
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
import {
  ensureStoreForShop,
  logStoreMutation,
} from "../../repositories/storeRepository.js";
import logger from "../../utils/loggerUtils.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";

const QUEUE_NAME = process.env.APP_INSTALLATION_QUEUE || "app-installation";
const productService = new Services();
const INSTALL_LEASE_MS = 5 * 60 * 1000;

export async function claimInstallation(shop, ownerId) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("appInstallationWorker.claimInstallation.updateMany", {
    shop,
    storeId: store.id,
  });

  const now = new Date();

  const claimed = await db.store.updateMany({
    where: {
      shopUrl: shop,
      OR: [
        { installationStatus: "UNINSTALLED" },
        { installedAt: null },
        {
          installationStatus: "INSTALLING",
          installationLeaseUntil: { lt: now },
        },
        { installationStatus: "INSTALL_FAILED" },
      ],
    },
    data: {
      installationStatus: "INSTALLING",
      installationExecutionId: ownerId,
      installationStage: "CLAIMED",
      installationLeaseUntil: new Date(now.getTime() + INSTALL_LEASE_MS),
      installationAttemptCount: { increment: 1 },
      uninstalledAt: null,
    },
  });

  return claimed.count === 1;
}

const appInstallationWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    if (!shop) {
      throw new Error("app-installation job requires shop");
    }

    const ownerId = `app-install:${job.id || "manual"}:${crypto.randomUUID()}`;

    // Always resolve from secure session store — never accept token from payload.
    const session = await getSession(shop);
    if (!session?.accessToken) {
      throw new Error(`app-installation session missing or invalid for shop: ${shop}`);
    }

    try {
      const claimed = await claimInstallation(shop, ownerId);
      if (!claimed) {
        logger.info("App installation already claimed, skipping", {
          worker: "appInstallationWorker",
          jobId: job.id,
          shop,
          attemptsMade: job.attemptsMade,
        });
        return {
          skipped: true,
          reason: "already_processed",
          shop,
        };
      }

      const { email, shopOwner } = await getShopOwnerEmailAddress(session);
      await confirmShopInstallation({
        session,
        email,
        shop,
        accessToken: session.accessToken,
      });

      const countResponse = await adminGraphqlWithRetry({
        session,
        shop,
        commandType: "productsCount",
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
            hasCompletedShopifyBulkJob: true,
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
        store.hasCompletedShopifyBulkJob !== true;

      if (shouldStartInitialSync) {
        await productService.startBulkOperationToFetchProducts({
          session,
          isInitialSync: true,
        });

        const ensuredStore = await ensureStoreForShop({ shop }, db);
        logStoreMutation("appInstallationWorker.initialSync.updateMany", {
          shop,
          storeId: ensuredStore.id,
        });
        await db.store.updateMany({
          where: {
            shopUrl: shop,
            installationExecutionId: ownerId,
          },
          data: {
            storeTotalProducts: count,
            isProductInitiallySyncing: true,
            hasCompletedShopifyBulkJob: false,
            installationStage: "INITIAL_SYNC_STARTED",
          },
        });
      } else {
        const ensuredStore = await ensureStoreForShop({ shop }, db);
        logStoreMutation("appInstallationWorker.skipInitialSync.updateMany", {
          shop,
          storeId: ensuredStore.id,
        });
        await db.store.updateMany({
          where: {
            shopUrl: shop,
            installationExecutionId: ownerId,
          },
          data: {
            storeTotalProducts: count,
            isProductInitiallySyncing: false,
            installationStage: "INITIAL_SYNC_SKIPPED",
          },
        });
      }

      await Promise.allSettled([
        sentWelcomeMailToStore({ email, shopOwner, shop }),
        sentInstalledMailToAdmin({ email, shop }),
      ]);

      const completed = await db.store.updateMany({
        where: {
          shopUrl: shop,
          installationStatus: "INSTALLING",
          installationExecutionId: ownerId,
        },
        data: {
          installationStatus: "INSTALLED",
          installedAt: new Date(),
          installationStage: "COMPLETED",
          installationLeaseUntil: null,
        },
      });

      if (completed.count !== 1) {
        throw new Error("INSTALLATION_OWNERSHIP_LOST");
      }

      logger.info("App installation background job completed", {
        worker: "appInstallationWorker",
        jobId: job.id,
        shop,
        startedInitialSync: shouldStartInitialSync,
      });

      return {
        success: true,
        shop,
        startedInitialSync: shouldStartInitialSync,
      };
    } catch (error) {
      await db.store.updateMany({
        where: {
          shopUrl: shop,
          installationStatus: "INSTALLING",
          installationExecutionId: ownerId,
        },
        data: {
          installationStatus: "INSTALL_FAILED",
          installationStage: "FAILED",
          installationLeaseUntil: null,
        },
      }).catch(() => {});

      await logWorkerError({
        shop,
        err: error,
        source: "AppInstallationWorker",
      });
      throw error;
    }
  },
  {
    connection,
    concurrency: 3,
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
