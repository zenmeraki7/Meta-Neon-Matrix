// web/services/collectionService/CollectionService.js

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
import { fetchMirrorCollections } from "../../repositories/collectionRepository.js";
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

const MAX_COLLECTION_FETCH_LIMIT = 100;
const MAX_LIVE_FETCH_LIMIT = 50;
const REFRESH_COOLDOWN_MS = 60_000;
const SHOPIFY_GRAPHQL_TIMEOUT_MS = 10_000;

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

  async #assertActiveStore(shop) {
    const store = await db.store.findUnique({
      where: { shopUrl: shop },
      select: {
        id: true,
        shopUrl: true,
        isActive: true,
        uninstalledAt: true,
        isCollectionSyncing: true,
        lastCollectionSyncAt: true,
        currentCollectionMirrorBatchId: true,
      },
    });

    if (!store || store.isActive === false || store.uninstalledAt != null) {
      const error = new Error("Shop is inactive or uninstalled");
      error.code = "UNAUTHENTICATED";
      throw error;
    }

    return store;
  }

  #assertRefreshCooldown(store) {
    if (store.isCollectionSyncing) {
      const error = new Error("Collection refresh is already in progress");
      error.code = "CONFLICT";
      throw error;
    }

    if (store.lastCollectionSyncAt) {
      const elapsed = Date.now() - new Date(store.lastCollectionSyncAt).getTime();
      if (elapsed < REFRESH_COOLDOWN_MS) {
        const remainingSec = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000);
        const error = new Error(
          `Collection refresh cooldown active. Please wait ${remainingSec}s before refreshing again.`,
        );
        error.code = "COOLDOWN_ACTIVE";
        throw error;
      }
    }
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

  async #executeShopifyGraphQLQuery(session, queryData, timeoutMs = SHOPIFY_GRAPHQL_TIMEOUT_MS) {
    const client = new this.shopify.api.clients.Graphql({ session });
    try {
      return await Promise.race([
        client.query({ data: queryData }),
        new Promise((_, reject) => {
          setTimeout(() => {
            const timeoutError = new Error("Shopify GraphQL request timed out");
            timeoutError.code = "TIMEOUT";
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      const message = String(error?.message || "").toLowerCase();
      if (
        message.includes("throttle")
        || message.includes("rate")
        || message.includes("too many requests")
        || message.includes("cost")
      ) {
        const throttleError = new Error("Shopify API rate limit exceeded");
        throttleError.code = "RATE_LIMITED";
        throw throttleError;
      }
      throw error;
    }
  }

  async fetchCollections(command) {
    const shop = assertShop(command);
    const store = await this.#assertActiveStore(shop);

    const search = String(command?.search || "").trim();
    const limit = Math.min(
      Math.max(Number(command?.limit) || 20, 1),
      MAX_COLLECTION_FETCH_LIMIT,
    );

    const cacheKey = `${shop}:fetchCollections:${search}:${limit}`;
    const cacheCollections = await getCache(cacheKey);

    if (cacheCollections) {
      metrics.cacheHits.inc({ source: "CACHE" });
      return { source: "CACHE", collections: cacheCollections };
    }

    metrics.cacheMisses.inc({ level: "L1" });

    const { collections: dbCollections, nextCursor } = await fetchMirrorCollections({
      shop,
      search,
      cursor: command?.cursor || null,
      limit,
    });

    await setCache(cacheKey, dbCollections, 300);
    return {
      source: "MIRROR",
      collections: dbCollections,
      nextCursor,
    };
  }

  async fetchFromShopify(command) {
    const shop = assertShop(command);
    await this.#assertActiveStore(shop);
    const session = await this.#loadOfflineSession(shop);

    // Reload authoritative subscription and entitlements using shop
    await assertFeatureEntitlement({
      shop,
      feature: "COLLECTION_LIVE_LOOKUP",
    });

    const search = String(command?.search || "").trim();
    const first = Math.min(
      Math.max(Number(command?.limit) || 20, 1),
      MAX_LIVE_FETCH_LIMIT,
    );
    const queryString = search ? `title:${search}*` : null;

    const response = await this.#executeShopifyGraphQLQuery(session, {
      query: GET_COLLECTIONS_QUERY,
      variables: {
        first,
        query: queryString,
      },
    });

    const edges = response?.body?.data?.collections?.edges || [];
    return {
      source: "SHOPIFY_LIVE",
      collections: edges.slice(0, MAX_LIVE_FETCH_LIMIT).map((edge) => ({
        shopifyId: edge?.node?.id || null,
        title: edge?.node?.title || null,
        handle: edge?.node?.handle || null,
      })),
    };
  }

  async clearCollections(session) {
    try {
      const shop = session.shop;
      const store = await this.#assertActiveStore(shop);

      const bulkResponse = await this.#executeShopifyGraphQLQuery(session, {
        query: BULK_OPERATION_MUTATION,
      });

      if (bulkResponse.body?.errors) {
        const error = new Error(bulkResponse.body.errors[0].message);
        error.code = "SHOPIFY_API_ERROR";
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

      await ensureStoreForShop({
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
    const store = await this.#assertActiveStore(shop);
    const session = await this.#loadOfflineSession(shop);

    // Reload authoritative subscription and entitlements using shop
    await assertFeatureEntitlement({
      shop,
      feature: "COLLECTION_REFRESH",
    });

    // Enforce refresh cooldown
    this.#assertRefreshCooldown(store);

    const idempotencyKey = String(command?.idempotencyKey || "").trim();
    if (!idempotencyKey) {
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
      key: idempotencyKey,
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
        const error = new Error("Collection refresh already in progress");
        error.code = "CONFLICT";
        throw error;
      }
      lockKey = lock.lockKey;

      const { status } = await getCurrentBulkOperationStatus(session, "QUERY");
      if (status === "RUNNING") {
        const error = new Error("Shopify bulk operation already running");
        error.code = "CONFLICT";
        throw error;
      }

      // Execute idempotency claim, immutable command, audit record, and outbox row in ONE transaction
      const transactionResult = await db.$transaction(async (tx) => {
        // Prevent multiple active refreshes for one shop
        const storeUpdate = await tx.store.updateMany({
          where: {
            shopUrl: shop,
            isCollectionSyncing: false,
          },
          data: {
            isCollectionSyncing: true,
            lastCollectionSyncAt: new Date(),
          },
        });

        if (storeUpdate.count === 0) {
          const error = new Error("Collection refresh already in progress for this shop");
          error.code = "CONFLICT";
          throw error;
        }

        // Create immutable command / operation record
        const syncHistory = await tx.syncHistory.create({
          data: {
            shop,
            status: "processing",
            stage: "COLLECTION_REFRESH_QUEUED",
            operationType: "Collection",
            duration: 0,
            recordCount: 0,
          },
        });

        const dedupeKey = `collection_refresh_${shop}_${syncHistory.id}`;

        // Create outbox enqueue intent with deterministic job ID
        const enqueueIntent = await tx.operationEnqueueIntent.create({
          data: {
            shop,
            queueRoutingKey: "collection_sync",
            queueJobName: "perform_collection_refresh",
            dispatchDedupeKey: dedupeKey,
            payload: {
              shop,
              syncHistoryId: syncHistory.id,
              idempotencyKey,
              actor: command?.actor || null,
            },
            status: "PENDING",
          },
        });

        return {
          syncHistory,
          enqueueIntent,
        };
      });

      // Clear cached sync details
      await clearKeyCaches(`${shop}:sync_details`);

      // Complete clearCollections via active session
      const clearResult = await this.clearCollections(session);

      const responsePayload = {
        operationId: clearResult.operationId,
        syncHistoryId: transactionResult.syncHistory.id,
        status: "ACCEPTED",
      };

      await this.idempotencyStore.complete({
        recordId: begin.recordId,
        response: responsePayload,
      });

      return responsePayload;
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
