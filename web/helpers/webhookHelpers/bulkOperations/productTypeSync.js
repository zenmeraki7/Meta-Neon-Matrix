import shopify from "../../../shopify.js";
import axios from "axios";
import readline from "readline";
import { getSession } from "../../../utils/sessionHandler.js";
import { Services } from "../../../services/productService/productFilterService.js";
import { emitToUser } from "../../../socket.js";
import { clearKeyCaches } from "../../../utils/cacheUtils.js";
import { enqueueAutomaticProductRuleSignalJob } from "../../../services/automaticProductRuleExecutionService.js";
import { db } from "../../../repositories/repositoryDb.js";
import {
  createMirrorBatchId,
  markFullSyncFailed,
} from "../../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../../services/mirrorAnomalyService.js";
import { markMirrorBatchStatus } from "../../../repositories/productSyncRepository.js";

const ACTIVE_SYNC_STAGES = [
  "SHOPIFY_BULK_RUNNING",
  "MIRROR_DOWNLOAD_STARTED",
  "MIRROR_STAGING",
  "INGESTING_TO_STAGING_BATCH",
  "VALIDATING_BATCH",
  "ACTIVATING_BATCH",
  "FILE_DOWNLOADING",
];

const ACTIVE_SYNC_STATUSES = ["processing"];
const BULK_OPERATION_DETAILS_TIMEOUT_MS = Number(
  process.env.BULK_OPERATION_DETAILS_TIMEOUT_MS || 30_000,
);
const BULK_RESULT_DOWNLOAD_TIMEOUT_MS = Number(
  process.env.BULK_RESULT_DOWNLOAD_TIMEOUT_MS || 60_000,
);
const PRODUCT_SYNC_IMPORT_TIMEOUT_MS = Number(
  process.env.PRODUCT_SYNC_IMPORT_TIMEOUT_MS || 10 * 60_000,
);

function withTimeout(promise, timeoutMs, message, onTimeout = null) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function transitionMirrorSyncFromHistory({
  shop,
  syncHistoryId,
  from,
  to,
  data = {},
}) {
  if (!shop || !syncHistoryId) return false;
  const updated = await db.operationFingerprint.updateMany({
    where: {
      shop,
      operationType: "MIRROR_SYNC",
      fingerprintResourceType: "sync_history",
      resourceId: String(syncHistoryId),
      status: Array.isArray(from) ? { in: from } : from,
    },
    data: {
      status: to,
      ...data,
      updatedAt: new Date(),
    },
  });
  return updated.count === 1;
}

export async function handleSyncOperation({ shopifyBulkOperationId, shop = null }) {
  let syncHistory = null;

  try {
    syncHistory = await db.syncHistory.findFirst({
      where: {
        shopifyBulkOperationId,
        ...(shop ? { shop } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    if (!syncHistory) {
      return {
        skipped: true,
        reason: "sync_history_not_found",
        shopifyBulkOperationId,
      };
    }

    // Idempotency: do not re-process a sync that already finalized
    if (
      syncHistory.operationType === "Product" &&
      (syncHistory.status === "completed" ||
        syncHistory.stage === "MIRROR_ACTIVATED" ||
        syncHistory.stage === "COMPLETED")
    ) {
      return {
        skipped: true,
        reason: "already_completed",
        shopifyBulkOperationId,
        syncHistoryId: syncHistory.id,
      };
    }

    // Atomic claim: only one worker may transition Shopify-completed -> mirror-processing
    if (syncHistory.operationType === "Product") {
      if (syncHistory.stage === "SHOPIFY_BULK_RUNNING") {
        const claimed = await db.syncHistory.updateMany({
          where: {
            id: syncHistory.id,
            status: "processing",
            stage: "SHOPIFY_BULK_RUNNING",
          },
          data: {
            stage: "MIRROR_DOWNLOAD_STARTED",
          },
        });

        if (claimed.count !== 1) {
          return {
            skipped: true,
            reason: "already_claimed_or_not_processable",
            shopifyBulkOperationId,
            syncHistoryId: syncHistory.id,
          };
        }
      } else if (!ACTIVE_SYNC_STAGES.includes(syncHistory.stage)) {
        return {
          skipped: true,
          reason: "sync_history_not_in_active_stage",
          shopifyBulkOperationId,
          syncHistoryId: syncHistory.id,
        };
      }

      syncHistory = await db.syncHistory.findUnique({
        where: { id: syncHistory.id },
      });
    }

    if (syncHistory.operationType === "Product" && !syncHistory.mirrorBatchId) {
      const mirrorBatchId = createMirrorBatchId("product_sync");

      const syncBatchSet = await db.syncHistory.updateMany({
        where: {
          id: syncHistory.id,
          shop: syncHistory.shop,
          status: { in: ACTIVE_SYNC_STATUSES },
          stage: { in: ACTIVE_SYNC_STAGES },
        },
        data: { mirrorBatchId },
      });
      if (syncBatchSet.count !== 1) {
        return {
          skipped: true,
          reason: "sync_batch_assignment_rejected",
          shopifyBulkOperationId,
          syncHistoryId: syncHistory.id,
        };
      }
      syncHistory = await db.syncHistory.findUnique({
        where: { id: syncHistory.id },
      });
    }

    if (
      (syncHistory.operationType === "Product" ||
        syncHistory.operationType === "Collection") &&
      syncHistory.mirrorBatchId
    ) {
      await db.mirrorBatch.upsert({
        where: {
          shop_id: {
            shop: syncHistory.shop,
            id: syncHistory.mirrorBatchId,
          },
        },
        update: {
          shop: syncHistory.shop,
          syncHistoryId: syncHistory.id,
          shopifyBulkOperationId,
          mirrorResourceType:
            syncHistory.operationType === "Collection"
              ? "COLLECTION_CATALOG"
              : "PRODUCT_CATALOG",
          status: "BULK_OPERATION_COMPLETED",
          failureReason: null,
          failedAt: null,
        },
        create: {
          id: syncHistory.mirrorBatchId,
          shop: syncHistory.shop,
          syncHistoryId: syncHistory.id,
          shopifyBulkOperationId,
          mirrorResourceType:
            syncHistory.operationType === "Collection"
              ? "COLLECTION_CATALOG"
              : "PRODUCT_CATALOG",
          status: "BULK_OPERATION_COMPLETED",
        },
      });
    }

    let recordCount = 0;
    const session = await getSession(syncHistory.shop);

    if (!session) {
      throw new Error(`No session found for shop ${syncHistory.shop}`);
    }

    const bulkOperation = await fetchBulkOperationDetails(session, shopifyBulkOperationId);

    if (!bulkOperation) {
      throw new Error("Failed to retrieve bulk operation details");
    }

    if (bulkOperation.errorCode) {
      throw new Error(
        `Bulk operation failed in Shopify. status=${bulkOperation.status} errorCode=${bulkOperation.errorCode}`,
      );
    }

    if (bulkOperation.status !== "COMPLETED") {
      throw new Error(
        `Bulk operation is not completed yet. status=${bulkOperation.status}`,
      );
    }

    if (!bulkOperation.url || typeof bulkOperation.url !== "string") {
      throw new Error(
        `Bulk operation completed but result URL is missing. status=${bulkOperation.status}`,
      );
    }

    await db.syncHistory.updateMany({
      where: {
        id: syncHistory.id,
        shop: syncHistory.shop,
        status: { in: ACTIVE_SYNC_STATUSES },
        stage: { in: ACTIVE_SYNC_STAGES },
      },
      data: {
        stage: "MIRROR_DOWNLOAD_STARTED",
        sourceResponseUrl: bulkOperation.url,
      },
    });

    if (
      (syncHistory.operationType === "Product" ||
        syncHistory.operationType === "Collection") &&
      syncHistory.mirrorBatchId
    ) {
      await markMirrorBatchStatus({
        shop: syncHistory.shop,
        mirrorBatchId: syncHistory.mirrorBatchId,
        status: "FILE_DOWNLOADING",
      });
    }

    const urlResponse = await axios.get(new URL(bulkOperation.url).toString(), {
      headers: { Accept: "application/json" },
      responseType: "stream",
      timeout: BULK_RESULT_DOWNLOAD_TIMEOUT_MS,
    });

    if (
      (syncHistory.operationType === "Product" ||
        syncHistory.operationType === "Collection") &&
      syncHistory.mirrorBatchId
    ) {
      await markMirrorBatchStatus({
        shop: syncHistory.shop,
        mirrorBatchId: syncHistory.mirrorBatchId,
        status: "FILE_DOWNLOADED",
      });
    }

    if (urlResponse.status !== 200) {
      throw new Error(`Failed to download bulk result. status=${urlResponse.status}`);
    }

    if (syncHistory.operationType === "Collection") {
      await processSyncDataInBatches(
        urlResponse.data,
        session.shop,
        "Collection",
        syncHistory.mirrorBatchId,
      );

      recordCount = await db.collection.count({
        where: {
          shop: session.shop,
          ...(syncHistory.mirrorBatchId
            ? { mirrorBatchId: syncHistory.mirrorBatchId }
            : {}),
        },
      });

      const collectionBatch = await db.mirrorBatch.findFirst({
        where: {
          shop: session.shop,
          id: syncHistory.mirrorBatchId,
          mirrorResourceType: "COLLECTION_CATALOG",
          status: { notIn: ["FAILED", "CLEANED"] },
        },
        select: { id: true },
      });
      if (!collectionBatch) {
        throw new Error("Collection mirror activation requires a valid COLLECTION_CATALOG batch");
      }

      await db.store.updateMany({
        where: {
          shopUrl: session.shop,
          isCollectionSyncing: true,
        },
        data: {
          isCollectionSyncing: false,
          lastCollectionSyncAt: new Date(),
          currentCollectionMirrorBatchId: syncHistory.mirrorBatchId,
          mirrorMutationVersion: { increment: 1 },
          lastCollectionReconcileAt: new Date(),
          lastReconcileAt: new Date(),
          mirrorHealthState: "HEALTHY",
          staleReason: null,
          requiresMirrorRepair: false,
        },
      });

      await clearKeyCaches(`${session.shop}:sync_details`);
      await clearKeyCaches(`${session.shop}:fetchCollections`);
      await clearKeyCaches(`${session.shop}:ProductFilterValues:collection`);

      const createdAt = bulkOperation.createdAt
        ? new Date(bulkOperation.createdAt)
        : new Date();
      const completedAt = bulkOperation.completedAt
        ? new Date(bulkOperation.completedAt)
        : new Date();
      const durationMs = Math.max(completedAt.getTime() - createdAt.getTime(), 0);

      const completed = await db.syncHistory.updateMany({
        where: {
          id: syncHistory.id,
          shop: syncHistory.shop,
          status: { in: ACTIVE_SYNC_STATUSES },
          stage: { in: ACTIVE_SYNC_STAGES },
        },
        data: {
          status: "completed",
          stage: "COMPLETED",
          sourceResponseUrl: bulkOperation.url,
          duration: durationMs,
          recordCount,
        },
      });
      if (completed.count !== 1) {
        return {
          skipped: true,
          reason: "collection_completion_transition_rejected",
          shopifyBulkOperationId,
          syncHistoryId: syncHistory.id,
        };
      }

      if (syncHistory.mirrorBatchId) {
        await markMirrorBatchStatus({
          shop: session.shop,
          mirrorBatchId: syncHistory.mirrorBatchId,
          status: "ACTIVE",
          counts: { actualCollections: recordCount },
        });
      }
    }

    if (syncHistory.operationType === "Product") {
      await transitionMirrorSyncFromHistory({
        shop: syncHistory.shop,
        syncHistoryId: syncHistory.id,
        from: "RUNNING",
        to: "INGESTING",
      }).catch(() => {});

      const service = new Services();

      const syncResult = await withTimeout(
        service.formatAndSyncProductsToDB({
          dataStream: urlResponse.data,
          shop: session.shop,
          session,
          mirrorBatchId: syncHistory.mirrorBatchId,
          syncHistoryId: syncHistory.id,
        }),
        PRODUCT_SYNC_IMPORT_TIMEOUT_MS,
        `Product sync import timed out after ${PRODUCT_SYNC_IMPORT_TIMEOUT_MS}ms`,
        () => urlResponse.data?.destroy?.(
          new Error(`Product sync import timed out after ${PRODUCT_SYNC_IMPORT_TIMEOUT_MS}ms`),
        ),
      );

      recordCount = syncResult.totalProductsProcessed || 0;

      await clearKeyCaches(`${session.shop}:ProductFetch:`);
      await clearKeyCaches(`${session.shop}:productTypes:`);
      await clearKeyCaches(`${session.shop}:ProductFilterValues:`);

      emitToUser(session.shop, "product_sync", {
        message: "Product sync completed",
        totalProductsProcessed: syncResult.totalProductsProcessed || 0,
        totalVariantsProcessed: syncResult.totalVariantsProcessed || 0,
      });

      await enqueueAutomaticProductRuleSignalJob({
        shop: session.shop,
        triggerReference: `reindex:${shopifyBulkOperationId}`,
        triggerSource: "REINDEX",
      });

      await transitionMirrorSyncFromHistory({
        shop: syncHistory.shop,
        syncHistoryId: syncHistory.id,
        from: ["RUNNING", "INGESTING"],
        to: "COMPLETED",
      }).catch(() => {});
    }

    await clearKeyCaches(`${session.shop}:storeDetails`);
    await clearKeyCaches(`${session.shop}:ProductFetch`);
    await clearKeyCaches(`${session.shop}:sync_details`);

    return { message: "syncing completed", recordCount };
  } catch (err) {
    if (syncHistory?.mirrorBatchId && syncHistory?.shop) {
      await markMirrorBatchStatus({
        shop: syncHistory.shop,
        mirrorBatchId: syncHistory.mirrorBatchId,
        status: "FAILED",
        failureReason: err.message,
      }).catch(() => {});
    }

    if (syncHistory) {
      await transitionMirrorSyncFromHistory({
        shop: syncHistory.shop,
        syncHistoryId: syncHistory.id,
        from: ["QUEUED", "STARTING_BULK_QUERY", "RUNNING", "INGESTING"],
        to: "FAILED",
        data: { lastError: err.message || String(err) },
      }).catch(() => {});

      await db.syncHistory
        .updateMany({
          where: {
            id: syncHistory.id,
            shop: syncHistory.shop,
            status: { in: ACTIVE_SYNC_STATUSES },
            stage: { in: ACTIVE_SYNC_STAGES },
          },
          data: {
            status: "failed",
            stage: "FAILED",
            errorMessage: err.message,
          },
        })
        .catch(() => {});
    }

    if (syncHistory?.shop) {
      await db.store
        .updateMany({
          where: {
            shopUrl: syncHistory.shop,
            OR: [
              { isProductSyncing: true },
              { isCollectionSyncing: true },
              { isProductTypeSyncing: true },
              { isProductInitiallySyncing: true },
            ],
          },
          data: {
            isProductSyncing: false,
            isCollectionSyncing: false,
            isProductTypeSyncing: false,
            isProductInitiallySyncing: false,
            syncProgressStage: "IDLE",
          },
        })
        .catch(() => {});

      await markFullSyncFailed({
        shop: syncHistory.shop,
        errorSummary: err.message,
      }).catch(() => {});

      await recordMirrorAnomaly({
        shop: syncHistory.shop,
        severity: "critical",
        type: "bulk_sync_finalize_failure",
        entityType: "syncHistory",
        entityId: syncHistory.id,
        message: err.message,
        details: {
          shopifyBulkOperationId,
          operationType: syncHistory.operationType,
        },
      }).catch(() => {});
    }

    throw err;
  }
}

async function fetchBulkOperationDetails(session, shopifyBulkOperationId) {
  const query = `query GetBulkOperationResults($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        url
        partialDataUrl
        objectCount
        rootObjectCount
        completedAt
        createdAt
        fileSize
        type
      }
    }
  }`;

  const client = new shopify.api.clients.Graphql({ session });
  const response = await withTimeout(
    client.query({
      data: {
        query,
        variables: { id: shopifyBulkOperationId },
      },
    }),
    BULK_OPERATION_DETAILS_TIMEOUT_MS,
    `Timed out fetching Shopify bulk operation details after ${BULK_OPERATION_DETAILS_TIMEOUT_MS}ms`,
  );

  return response.body?.data?.node;
}

export async function processSyncDataInBatches(
  dataStream,
  shop,
  type,
  mirrorBatchId = null,
) {
  const batchSize = 100;
  let batch = [];

  const insertBatch = async () => {
    if (!batch.length) return;

    if (type === "Collection") {
      const seen = new Set();
      const uniqueCollections = batch.filter((collection) => {
        if (!collection.title || !collection.shopifyId) return false;
        const key = collection.shopifyId;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      await db.collection.createMany({
        data: uniqueCollections.map((collection) => ({
          shop,
          shopifyId: collection.shopifyId,
          mirrorBatchId: mirrorBatchId,
          title: collection.title,
          handle: null,
        })),
        skipDuplicates: true,
      });
    }

    batch = [];
  };

  const rl = readline.createInterface({
    input: dataStream,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;

    try {
      const json = JSON.parse(line);

      if (type === "Collection") {
        batch.push({
          shopifyId: json.id,
          title: json.title?.trim(),
        });
      }

      if (batch.length >= batchSize) {
        rl.pause();
        await insertBatch();
        rl.resume();
      }
    } catch (error) {
      await recordMirrorAnomaly({
        shop,
        severity: "medium",
        type: "sync_stream_parse_error",
        entityType: "store",
        entityId: shop,
        message: error.message,
        details: { type },
      }).catch(() => {});
    }
  });

  return new Promise((resolve, reject) => {
    rl.on("close", async () => {
      try {
        await insertBatch();

        if (type === "Collection" && mirrorBatchId) {
          const store = await db.store.findUnique({
            where: { shopUrl: shop },
            select: { currentCollectionMirrorBatchId: true },
          });

          if (
            store?.currentCollectionMirrorBatchId &&
            store.currentCollectionMirrorBatchId !== mirrorBatchId
          ) {
            await db.collection.deleteMany({
              where: {
                shop,
                mirrorBatchId: store.currentCollectionMirrorBatchId,
              },
            });
          }
        }

        resolve();
      } catch (error) {
        reject(error);
      }
    });

    rl.on("error", reject);
  });
}
