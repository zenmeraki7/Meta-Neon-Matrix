import logger from "../../utils/loggerUtils.js";
import { getCache, setCache, clearKeyCaches } from "../../utils/cacheUtils.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { getProductSyncCacheKeys } from "../../utils/cacheKeyRegistry.js";

import { db } from "../../repositories/repositoryDb.js";
import { createMirrorBatchId } from "../mirrorHealthService.js";
import { assertFeatureEntitlement } from "../entitlement/featureEntitlementService.js";
import {
  IdempotencyStoreService,
  buildIdempotencyRequestHash,
} from "../idempotency/IdempotencyStoreService.js";
import {
  acquireExclusiveShopWork,
  releaseExclusiveShopWork,
  LOCK_NS,
} from "../shopWorkLeaseService.js";
import { requireShopScope } from "../../utils/shopScope.js";
import {
  GetCollections,
  StartCollectionBulkSyncMutation,
} from "../../graphql/collection.js";

const BLOCKING_BULK_OPERATION_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);

export class CollectionService {
  constructor(shopifyClient) {
    this.shopify = shopifyClient;
    this.idempotencyStore = new IdempotencyStoreService(db);
  }

  async #loadOfflineSession(shop) {
    const offlineSessionId = this.shopify.api.session.getOfflineId(shop);
    const session = await this.shopify.config.sessionStorage.loadSession(offlineSessionId);
    if (!session?.shop || session.shop !== shop) {
      const error = new Error("Unauthenticated Shopify session");
      error.code = "UNAUTHENTICATED";
      throw error;
    }
    return session;
  }

  async fetchCollections(command) {
    const shop = requireShopScope(command?.shop);
    const search = String(command?.search || "").trim();
    const limit = Math.min(Math.max(Number(command?.limit) || 20, 1), 50);

    const store = await db.store.findUnique({
      where: { shopUrl: shop },
      select: { activeCollectionBatchId: true },
    });
    const activeCollectionBatchId = store?.activeCollectionBatchId || null;
    if (!activeCollectionBatchId) {
      return {
        source: "MIRROR_EMPTY",
        collections: [],
        reason: "ACTIVE_COLLECTION_MIRROR_BATCH_NOT_FOUND",
      };
    }

    const cacheKey = `${shop}:fetchCollections:v2:${activeCollectionBatchId}:${search}:${limit}`;
    const cacheCollections = await getCache(cacheKey);
    if (cacheCollections) {
      return { source: "CACHE", collections: cacheCollections };
    }

    const dbCollections = await db.collection.findMany({
      where: {
        shop,
        mirrorBatchId: activeCollectionBatchId,
        ...(search
          ? {
              title: {
                contains: search,
                mode: "insensitive",
              },
            }
          : {}),
      },
      take: limit,
      select: {
        id: true,
        shopifyId: true,
        title: true,
        handle: true,
      },
    });

    await setCache(cacheKey, dbCollections, 300);
    return { source: "MIRROR", collections: dbCollections };
  }

  async fetchFromShopify(command) {
    const shop = requireShopScope(command?.shop);
    const session = await this.#loadOfflineSession(shop);
    await assertFeatureEntitlement({
      shop,
      feature: "COLLECTION_LIVE_LOOKUP",
      subscription: command?.subscription || null,
    });

    const search = String(command?.search || "").trim();
    const first = Math.min(Math.max(Number(command?.limit) || 20, 1), 50);
    const queryString = search ? `title:${search}*` : null;

    const client = new this.shopify.api.clients.Graphql({ session });

    let collections = [];
    let after = null;
    try {
      do {
        const response = await Promise.race([
          client.query({
            data: {
              query: GetCollections,
              variables: {
                first: Math.min(first - collections.length, 50),
                after,
                query: queryString,
              },
            },
          }),
          new Promise((_, reject) => {
            setTimeout(() => {
              const timeoutError = new Error("Shopify collection lookup timed out");
              timeoutError.code = "TIMEOUT";
              reject(timeoutError);
            }, 8000);
          }),
        ]);

        const connection = response?.body?.data?.collections || {};
        const edges = Array.isArray(connection?.edges) ? connection.edges : [];
        collections = collections.concat(
          edges.map((edge) => ({
            shopifyId: edge?.node?.id || null,
            title: edge?.node?.title || null,
            handle: edge?.node?.handle || null,
          })),
        );
        after = connection?.pageInfo?.hasNextPage
          ? connection?.pageInfo?.endCursor || null
          : null;
      } while (after && collections.length < first);
    } catch (error) {
      const message = String(error?.message || "").toLowerCase();
      if (
        message.includes("throttle")
        || message.includes("rate")
        || message.includes("too many requests")
      ) {
        const throttleError = new Error("Shopify API throttled request");
        throttleError.code = "RATE_LIMITED";
        throw throttleError;
      }
      throw error;
    }

    return {
      source: "SHOPIFY_LIVE",
      collections: collections.slice(0, first),
    };
  }

  async startCollectionSync(session) {
    const shop = requireShopScope(session?.shop, "session.shop");
    if (session.shop !== shop) {
      throw new Error("COLLECTION_SYNC_SESSION_SHOP_INVALID");
    }
    const syncBatchId = createMirrorBatchId("collection_sync");
    const executionId = createMirrorBatchId("collection_execution");
    const syncHistory = await db.syncHistory.create({
      data: {
        shop,
        status: "processing",
        syncBatchId,
        stage: "SHOPIFY_BULK_SUBMITTING",
        operationType: "Collection",
        duration: 0,
        recordCount: 0,
        executionState: "submitting",
        executionIdentity: executionId,
      },
    });

    try {
      const client = new this.shopify.api.clients.Graphql({ session });
      const currentBulkOperation = await getCurrentBulkOperationStatus(session, "QUERY");
      const currentStatus = String(currentBulkOperation?.status || "").toUpperCase();
      if (BLOCKING_BULK_OPERATION_STATUSES.has(currentStatus)) {
        const error = new Error(`BULK_OPERATION_IN_PROGRESS:${currentStatus}`);
        error.code = "BULK_OPERATION_IN_PROGRESS";
        error.retryable = true;
        error.currentBulkOperation = currentBulkOperation;
        throw error;
      }

      const bulkResponse = await client.query({
        data: {
          query: StartCollectionBulkSyncMutation,
        },
      });
      if (bulkResponse.body.errors) {
        const error = new Error(bulkResponse.body.errors[0].message);
        error.code = "INTERNAL_ERROR";
        throw error;
      }
      const userErrors = bulkResponse?.body?.data?.bulkOperationRunQuery?.userErrors || [];
      if (userErrors.length) {
        const error = new Error(`SHOPIFY_USER_ERRORS:${JSON.stringify(userErrors)}`);
        error.code = "SHOPIFY_USER_ERRORS";
        throw error;
      }
      const bulkOperationId =
        bulkResponse.body.data.bulkOperationRunQuery.bulkOperation?.id;
      if (!bulkOperationId) {
        throw new Error("COLLECTION_BULK_OPERATION_ID_MISSING");
      }

      await db.$transaction([
        db.store.update({
          where: { shopUrl: shop },
          data: {
            isCollectionSyncing: true,
            lastCollectionSyncAt: new Date(),
          },
        }),
        db.syncHistory.updateMany({
          where: { id: syncHistory.id, shop },
          data: {
            bulkOperationId,
            stage: "SHOPIFY_BULK_RUNNING",
            executionState: "running",
          },
        }),
      ]);

      return {
        syncHistoryId: syncHistory.id,
        operationId: bulkOperationId,
        bulkOperationId,
        syncBatchId,
        executionId,
        status: "ACCEPTED",
      };
    } catch (err) {
      await db.syncHistory.updateMany({
        where: { id: syncHistory.id, shop },
        data: {
          status: "failed",
          stage: "SHOPIFY_BULK_SUBMIT_FAILED",
          executionState: "failed",
          errorMessage: String(err?.message || err).slice(0, 2000),
        },
      }).catch(() => {});
      logger.error("Failed to start collection sync", {
        shop,
        error: err.message,
      });
      throw err;
    }
  }

  async performCollectionRefresh(command) {
    const shop = requireShopScope(command?.shop);
    const session = await this.#loadOfflineSession(shop);
    await assertFeatureEntitlement({
      shop,
      feature: "COLLECTION_REFRESH",
      subscription: command?.subscription || null,
    });

    if (!command?.idempotencyKey) {
      const error = new Error("Idempotency key required");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }

    const requestHash = buildIdempotencyRequestHash({
      shop,
      operation: "collection_refresh",
      actorType: command?.actor?.type || "UNKNOWN",
      actorUserId: command?.actor?.userId || null,
    });
    const begin = await this.idempotencyStore.begin({
      shop,
      scope: "collection_refresh",
      key: String(command.idempotencyKey).trim(),
      requestHash,
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    let lockKey = null;
    try {
      const lock = await acquireExclusiveShopWork({
        shop,
        namespace: LOCK_NS.WRITE_CATALOG,
        activity: "collection_refresh",
        worker: "CollectionService.performCollectionRefresh",
        queue: "http",
      });
      if (!lock?.acquired) {
        const error = new Error("CONFLICT");
        error.code = "CONFLICT";
        throw error;
      }
      lockKey = lock.lockKey;

      const { status } = await getCurrentBulkOperationStatus(session, "QUERY");
      if (BLOCKING_BULK_OPERATION_STATUSES.has(String(status || "").toUpperCase())) {
        const error = new Error("CONFLICT");
        error.code = "CONFLICT";
        throw error;
      }

      const result = await this.startCollectionSync(session);
      await Promise.all(getProductSyncCacheKeys(shop).map((key) => clearKeyCaches(key)));
      await this.idempotencyStore.complete({
        recordId: begin.recordId,
        shop,
        response: result,
      });
      return result;
    } catch (error) {
      throw error;
    } finally {
      await releaseExclusiveShopWork(lockKey);
    }
  }
}
