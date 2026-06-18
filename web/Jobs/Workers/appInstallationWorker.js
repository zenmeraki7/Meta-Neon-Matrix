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
import {
  ensureStoreForShop,
  logStoreMutation,
} from "../../repositories/storeRepository.js";
import logger from "../../utils/loggerUtils.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";

const QUEUE_NAME = process.env.APP_INSTALLATION_QUEUE || "app-installation";
const productService = new Services();

async function claimInstallation(shop) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("appInstallationWorker.claimInstallation.updateMany", {
    shop,
    storeId: store.id,
  });
  const result = await db.store.updateMany({
    where: {
      shopUrl: shop,
      OR: [
        { installedAt: null },
        { isUnInstalled: true },
      ],
    },
    data: {
      isUnInstalled: false,
      installedAt: new Date(),
      unInstalledAt: null,
    },
  });

  return result.count > 0;
}

const appInstallationWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    if (!shop) {
      throw new Error("app-installation job requires shop");
    }

    // Always resolve from secure session store — never accept token from payload.
    const session = await getSession(shop);
    if (!session?.accessToken) {
      throw new Error(`app-installation session missing or invalid for shop: ${shop}`);
    }

    try {
      const claimed = await claimInstallation(shop);
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
          where: { shopUrl: shop },
          data: {
            storeTotalProducts: count,
            isProductInitialySyning: true,
            shopifyBulkJobCompleted: false,
          },
        });
      } else {
        const ensuredStore = await ensureStoreForShop({ shop }, db);
        logStoreMutation("appInstallationWorker.skipInitialSync.updateMany", {
          shop,
          storeId: ensuredStore.id,
        });
        await db.store.updateMany({
          where: { shopUrl: shop },
          data: {
            storeTotalProducts: count,
            isProductInitialySyning: false,
          },
        });
      }

      await Promise.allSettled([
        sentWelcomeMailToStore({ email, shopOwner, shop }),
        sentInstalledMailToAdmin({ email, shop }),
      ]);

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
