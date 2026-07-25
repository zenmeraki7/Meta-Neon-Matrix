import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import shopify from "../../shopify.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  ensureStoreForShop,
  logStoreMutation,
} from "../../repositories/storeRepository.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";

const QUEUE_NAME =
  process.env.PRODUCT_SYNC_CLEAR_PRODUCT_TYPES_QUEUE || "product-sync-clear-product-types";

const BULK_OPERATION_MUTATION = `mutation {
  bulkOperationRunQuery(
    query: """
      {
        products {
          edges {
            node {
              id
              productType
            }
          }
        }
      }
    """
  ) {
    bulkOperation {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}`;

const productSyncClearProductTypesWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { shop, operationId, executionId } = job.data || {};
    if (!shop || !operationId || !executionId) {
      throw new Error("product sync clear product types job requires shop, operationId, and executionId");
    }

    const syncHistory = await db.syncHistory.findFirst({
      where: { id: operationId, shop },
      select: { id: true, status: true, shopifyBulkOperationId: true },
    });
    if (!syncHistory) {
      throw new Error("SYNC_HISTORY_NOT_FOUND");
    }
    if (syncHistory.shopifyBulkOperationId) {
      return { skipped: true, reason: "already_submitted", operationId, shop };
    }

    const session = await getSession(shop);
    if (!session?.shop || session.shop !== shop) {
      throw new Error("SHOP_SESSION_NOT_AVAILABLE");
    }

    const { status } = await getCurrentBulkOperationStatus(session, "QUERY");
    if (status === "RUNNING") {
      throw new Error("SHOPIFY_QUERY_BULK_OPERATION_RUNNING");
    }

    const client = new shopify.api.clients.Graphql({ session });
    const bulkResponse = await client.query({
      data: {
        query: BULK_OPERATION_MUTATION,
      },
    });

    if (bulkResponse?.body?.errors?.length) {
      throw new Error(String(bulkResponse.body.errors[0]?.message || "SHOPIFY_QUERY_ERROR"));
    }

    const userErrors = bulkResponse?.body?.data?.bulkOperationRunQuery?.userErrors || [];
    if (userErrors.length) {
      throw new Error(`SHOPIFY_USER_ERRORS:${JSON.stringify(userErrors)}`);
    }

    const shopifyBulkOperationId =
      bulkResponse?.body?.data?.bulkOperationRunQuery?.bulkOperation?.id || null;
    if (!shopifyBulkOperationId) {
      throw new Error("MISSING_BULK_OPERATION_ID");
    }

    await db.$transaction(async (tx) => {
      const store = await ensureStoreForShop({ shop }, tx);
      logStoreMutation("productSyncClearProductTypesWorker.store.updateMany", {
        shop,
        storeId: store.id,
        syncHistoryId: operationId,
        shopifyBulkOperationId,
      });
      await tx.store.updateMany({
        where: { shopUrl: shop },
        data: {
          isProductTypeSyncing: true,
          lastProductTypeSyncAt: new Date(),
        },
      });
      await tx.syncHistory.update({
        where: { id: operationId },
        data: {
          status: "processing",
          shopifyBulkOperationId,
        },
      });
    });

    await clearKeyCaches(`${shop}:sync_details`);

    return {
      success: true,
      shop,
      operationId,
      shopifyBulkOperationId,
    };
  },
  {
    connection,
    concurrency: 1,
  },
);

export default productSyncClearProductTypesWorker;

