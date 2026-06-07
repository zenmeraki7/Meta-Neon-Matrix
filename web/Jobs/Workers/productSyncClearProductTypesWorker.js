import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import shopify from "../../shopify.js";
import { db } from "../../repositories/repositoryDb.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { getProductSyncCacheKeys } from "../../utils/cacheKeyRegistry.js";

const QUEUE_NAME =
  process.env.PRODUCT_SYNC_CLEAR_PRODUCT_TYPES_QUEUE || "product-sync-clear-product-types";
const ACTIVE_BULK_OPERATION_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);

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
      select: {
        id: true,
        status: true,
        bulkOperationId: true,
        executionIdentity: true,
      },
    });
    if (!syncHistory) {
      throw new Error("SYNC_HISTORY_NOT_FOUND");
    }
    if (syncHistory.executionIdentity && syncHistory.executionIdentity !== executionId) {
      return {
        skipped: true,
        reason: "stale_execution",
        operationId,
        shop,
      };
    }
    if (syncHistory.bulkOperationId) {
      return { skipped: true, reason: "already_submitted", operationId, shop };
    }

    const session = await getSession(shop);
    if (!session?.shop || session.shop !== shop) {
      throw new Error("SHOP_SESSION_NOT_AVAILABLE");
    }

    const currentBulkOperation = await getCurrentBulkOperationStatus(session, "QUERY");
    const status = String(currentBulkOperation?.status || "").toUpperCase();
    if (ACTIVE_BULK_OPERATION_STATUSES.has(status)) {
      const error = new Error(`BULK_OPERATION_IN_PROGRESS:${status}`);
      error.retryable = true;
      error.currentBulkOperation = currentBulkOperation;
      throw error;
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

    const bulkOperationId =
      bulkResponse?.body?.data?.bulkOperationRunQuery?.bulkOperation?.id || null;
    if (!bulkOperationId) {
      throw new Error("MISSING_BULK_OPERATION_ID");
    }

    await db.$transaction([
      db.store.update({
        where: { shopUrl: shop },
        data: {
          isProductTypeSyncing: true,
          lastProductTypeSyncAt: new Date(),
        },
      }),
      db.syncHistory.updateMany({
        where: { id: operationId, shop },
        data: {
          status: "processing",
          bulkOperationId,
        },
      }),
    ]);

    await Promise.all(getProductSyncCacheKeys(shop).map((key) => clearKeyCaches(key)));

    return {
      success: true,
      shop,
      operationId,
      bulkOperationId,
    };
  },
  {
    connection,
    concurrency: 1,
  },
);

export default productSyncClearProductTypesWorker;
