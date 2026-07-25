import logger from "../../utils/loggerUtils.js";
import promClient from "prom-client";
import { getCache, setCache, clearKeyCaches } from "../../utils/cacheUtils.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";

import { db } from "../../repositories/repositoryDb.js";
import {
  ensureStoreForShop,
  logStoreMutation,
} from "../../repositories/storeRepository.js";
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

export const metrics = {
  collectionFetchLatency: new promClient.Histogram({
    name: "collection_fetch_latency_seconds",
    help: "Time to fetch collections by source",
    buckets: [0.1, 0.3, 0.5, 1, 2, 5],
    labelNames: ["source"],
  }),
  cacheHits: new promClient.Counter({
    name: "collection_cache_hit_total",
    help: "Cache hits by source",
    labelNames: ["source"],
  }),
  cacheMisses: new promClient.Counter({
    name: "collection_cache_miss_total",
    help: "Cache misses total",
    labelNames: ["level"],
  }),
  syncJobs: new promClient.Counter({
    name: "collection_sync_jobs_total",
    help: "Total sync jobs by status",
    labelNames: ["status"],
  }),
};

const BULK_OPERATION_MUTATION = `mutation {
  bulkOperationRunQuery(
    query: """
      {
        collections {
          edges {
            node {
              id
              title
              handle
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

const GET_COLLECTIONS_QUERY = `#graphql
  query GetCollections($first: Int!, $query: String) {
    collections(first: $first, query: $query) {
      edges {
        node {
          id
          title
          handle
        }
      }
    }
  }
`;

function assertShop(command) {
  const shop = command?.shop;
  if (!shop || typeof shop !== "string") {
    const error = new Error("Shop isolation violation");
    error.code = "FORBIDDEN";
    throw error;
  }
  return shop;
}

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
    const shop = assertShop(command);
    const search = String(command?.search || "").trim();
    const limit = Math.min(Math.max(Number(command?.limit) || 20, 1), 50);

    const cacheKey = `${shop}:fetchCollections:${search}:${limit}`;
    const cacheCollections = await getCache(cacheKey);

    if (cacheCollections) {
      return { source: "CACHE", collections: cacheCollections };
    }

    const store = await db.store.findUnique({
      where: { shopUrl: shop },
      select: { currentCollectionMirrorBatchId: true },
    });

    const dbCollections = await db.collection.findMany({
      where: {
        shop,
        ...(store?.currentCollectionMirrorBatchId
          ? { mirrorBatchId: store.currentCollectionMirrorBatchId }
          : {}),
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
    const shop = assertShop(command);
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

    let response;
    try {
      response = await Promise.race([
        client.query({
          data: {
            query: GET_COLLECTIONS_QUERY,
            variables: {
              first,
              query: queryString,
            },
          },
        }),
        new Promise((_, reject) => {
          setTimeout(() => {
            const timeoutError = new Error("Shopify collection lookup timed out");
            timeoutError.code = "RATE_LIMITED";
            reject(timeoutError);
          }, 8000);
        }),
      ]);
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

    const edges = response?.body?.data?.collections?.edges || [];
    return {
      source: "SHOPIFY_LIVE",
      collections: edges.map((edge) => ({
        shopifyId: edge?.node?.id || null,
        title: edge?.node?.title || null,
        handle: edge?.node?.handle || null,
      })),
    };
  }

  async clearCollections(session) {
    try {
      const shop = session.shop;
      const client = new this.shopify.api.clients.Graphql({ session });
      const bulkResponse = await client.query({
        data: {
          query: BULK_OPERATION_MUTATION,
        },
      });
      if (bulkResponse.body.errors) {
        const error = new Error(bulkResponse.body.errors[0].message);
        error.code = "INTERNAL_ERROR";
        throw error;
      }
      const result = bulkResponse?.body?.data?.bulkOperationRunQuery;
      const userErrors = Array.isArray(result?.userErrors) ? result.userErrors : [];
      if (userErrors.length) {
        const error = new Error(userErrors.map((item) => item.message).join("; "));
        error.code = "SHOPIFY_USER_ERROR";
        throw error;
      }
      const shopifyBulkOperationId = result?.bulkOperation?.id;
      if (!shopifyBulkOperationId) {
        throw new Error("COLLECTION_BULK_OPERATION_ID_MISSING");
      }
      const mirrorBatchId = createMirrorBatchId("collection_sync");

      const store = await ensureStoreForShop({
        shop,
        accessToken: session.accessToken,
        oauthScopes: session.scope,
      });
      logStoreMutation("CollectionService.clearCollections.updateMany", {
        shop,
        storeId: store.id,
        mirrorBatchId,
        shopifyBulkOperationId,
      });
      await db.store.updateMany({
        where: { shopUrl: shop },
        data: {
          isCollectionSyncing: true,
          lastCollectionSyncAt: new Date(),
        },
      });

      await db.syncHistory.create({
        data: {
          shop,
          status: "processing",
          shopifyBulkOperationId,
          mirrorBatchId,
          stage: "SHOPIFY_BULK_RUNNING",
          operationType: "Collection",
          duration: 0,
          recordCount: 0,
        },
      });

      return {
        operationId: shopifyBulkOperationId,
        status: "ACCEPTED",
      };
    } catch (err) {
      logger.error("Failed to clear collections", {
        shop: session.shop,
        error: err.message,
      });
      throw err;
    }
  }

  async performCollectionRefresh(command) {
    const shop = assertShop(command);
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
      if (status === "RUNNING") {
        const error = new Error("CONFLICT");
        error.code = "CONFLICT";
        throw error;
      }

      const result = await this.clearCollections(session);
      await clearKeyCaches(`${shop}:sync_details`);
      await this.idempotencyStore.complete({
        recordId: begin.recordId,
        response: result,
      });
      return result;
    } catch (error) {
      if (begin?.recordId) {
        await db.filterTrack.delete({ where: { id: begin.recordId } }).catch(() => {});
      }
      throw error;
    } finally {
      await releaseExclusiveShopWork(lockKey);
    }
  }

  async requestCollectionRefresh(command) {
    return this.performCollectionRefresh(command);
  }
}
