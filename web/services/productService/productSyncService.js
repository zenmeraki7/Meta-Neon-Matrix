import readline from "node:readline";
import {
  activateProductMirrorBatch,
  clearProductSyncCache,
  insertProductMirrorBatch,
  markMirrorBatchStatus,
  markProductSyncStarted,
  markSyncHistoryFailed,
  queueProductSyncStart,
  stageProductMirrorBatch,
  updateInitialSyncProgress,
  validateAndFinalizeProductMirrorBatch,
} from "../../repositories/productSyncRepository.js";
import { runProductBulkFetch } from "./productSyncGateway.js";
import {
  extractCollections,
  extractMetafields,
  extractVariants,
  flattenProduct,
  flattenVariant,
} from "./productSyncTransformers.js";
import {
  extractMetaobjectIds,
  fetchMetaobjectLookupByIds,
} from "./productSyncMetaobjects.js";
import { db } from "../../repositories/repositoryDb.js";
import { ensureStoreForShop } from "../../repositories/storeRepository.js";
import { recordMirrorAnomaly } from "../mirrorAnomalyService.js";

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function getSuspiciousPartialSyncThreshold() {
  const parsed = Number(
    process.env.SUSPICIOUS_PARTIAL_PRODUCT_SYNC_THRESHOLD ?? "0.5",
  );
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}

function parseTypedMetafieldValue(rawType, rawValue) {
  const valueType = typeof rawType === "string" ? rawType.trim() : "";
  const textValue =
    rawValue === null || rawValue === undefined
      ? null
      : String(rawValue);
  const normalizedText = textValue
    ? textValue.trim().toLowerCase()
    : null;

  let valueNumber = null;
  let valueBoolean = null;
  let valueDate = null;

  if (
    textValue &&
    ["number_integer", "number_decimal", "rating", "money"].includes(
      valueType,
    )
  ) {
    const parsed = Number(textValue);
    if (!Number.isNaN(parsed)) valueNumber = parsed.toString();
  }

  if (normalizedText === "true") valueBoolean = true;
  if (normalizedText === "false") valueBoolean = false;

  if (textValue && ["date", "date_time"].includes(valueType)) {
    const milliseconds = Date.parse(textValue);
    if (!Number.isNaN(milliseconds)) valueDate = new Date(milliseconds);
  }

  return {
    valueText: textValue,
    valueTextNormalized: normalizedText,
    valueNumber,
    valueBoolean,
    valueDate,
  };
}

function createProductAccumulator(node, collectMetaobjectRefs) {
  const productMetafields = extractMetafields(node.metafields);
  collectMetaobjectRefs(productMetafields);

  return {
    ...node,
    variants: extractVariants(node.variants),
    metafields: productMetafields,
    collections: extractCollections(node.collections),
    options: Array.isArray(node.options) ? node.options : [],
    featuredMedia: node.featuredMedia || null,
  };
}

function attachChildToOwner({
  child,
  productsById,
  variantsById,
  inventoryItemsById,
  collectMetaobjectRefs,
}) {
  const parentId = String(child?.__parentId || "").trim();
  if (!parentId) return false;

  if (child.__typename === "ProductVariant") {
    const product = productsById.get(parentId);
    if (!product) return false;

    const variant = {
      id: child.id,
      title: child.title,
      sku: child.sku,
      barcode: child.barcode,
      price: child.price,
      compareAtPrice: child.compareAtPrice,
      inventoryQuantity: child.inventoryQuantity,
      inventoryPolicy: child.inventoryPolicy,
      taxable: child.taxable,
      taxCode: child.taxCode,
      position: child.position,
      selectedOptions: Array.isArray(child.selectedOptions)
        ? child.selectedOptions
        : [],
      inventoryItem: child.inventoryItem || null,
      metafields: [],
    };

    product.variants.push(variant);
    variantsById.set(String(child.id), { product, variant });
    if (variant.inventoryItem?.id) {
      variant.inventoryItem.inventoryLevels = variant.inventoryItem.inventoryLevels || { edges: [] };
      inventoryItemsById.set(String(variant.inventoryItem.id), { product, variant, inventoryItem: variant.inventoryItem });
    }
    return true;
  }

  if (child.__typename === "InventoryLevel") {
    const owner = inventoryItemsById.get(parentId);
    if (!owner) return false;
    const container = owner.inventoryItem.inventoryLevels || { edges: [] };
    if (!Array.isArray(container.edges)) container.edges = [];
    container.edges.push({ node: child });
    owner.inventoryItem.inventoryLevels = container;
    return true;
  }

  if (child.__typename === "Collection") {
    const product = productsById.get(parentId);
    if (!product) return false;
    product.collections.push({
      id: child.id,
      title: child.title,
    });
    return true;
  }

  if (child.__typename === "Metafield") {
    const metafield = {
      id: child.id || null,
      namespace: child.namespace,
      key: child.key,
      type: child.type,
      value: child.value,
    };

    const product = productsById.get(parentId);
    if (product) {
      product.metafields.push(metafield);
      collectMetaobjectRefs([metafield]);
      return true;
    }

    const variantOwner = variantsById.get(parentId);
    if (variantOwner) {
      variantOwner.variant.metafields.push(metafield);
      collectMetaobjectRefs([metafield]);
      return true;
    }

    return false;
  }

  if (child.__typename === "MediaImage") {
    const product = productsById.get(parentId);
    if (!product) return false;
    product.featuredMedia = child;
    return true;
  }

  return false;
}

export async function startBulkOperationToFetchProducts({
  session,
  isInitialSync = false,
}) {
  const shop = String(session?.shop || "").trim();
  if (!shop) throw new Error("Shopify session shop is required");

  await ensureStoreForShop({
    shop,
    accessToken: session.accessToken,
    scope: session.scope,
  });

  await markProductSyncStarted({ shop });

  const { bulkOperationId, responseBody } =
    await runProductBulkFetch({ session });

  const syncHistory = await queueProductSyncStart({
    shop,
    bulkOperationId,
    isInitialSync,
  });

  await clearProductSyncCache(shop);

  return {
    message: "Bulk product sync started",
    bulkOperationId,
    syncHistoryId: syncHistory.id,
    syncBatchId: syncHistory.syncBatchId,
    response: responseBody,
  };
}

export async function formatAndSyncProductsToDB({
  dataStream,
  shop,
  session,
  syncBatchId,
  syncHistoryId = null,
}) {
  if (!shop || !syncBatchId) {
    throw new Error("shop and syncBatchId are required");
  }

  const batchSize = boundedInteger(
    process.env.PRODUCT_SYNC_INGEST_BATCH_SIZE,
    2_500,
    250,
    10_000,
  );
  const maxPendingChildren = boundedInteger(
    process.env.PRODUCT_SYNC_MAX_PENDING_CHILDREN,
    100_000,
    1_000,
    1_000_000,
  );
  const stallTimeoutMs = boundedInteger(
    process.env.PRODUCT_SYNC_STREAM_STALL_TIMEOUT_MS,
    120_000,
    30_000,
    900_000,
  );

  let streamStallTimer = null;

  try {
    await markMirrorBatchStatus({
      shop,
      syncBatchId,
      status: "FILE_DOWNLOADED",
    });
    await stageProductMirrorBatch({ shop, syncBatchId, syncHistoryId });

    const productsById = new Map();
    const variantsById = new Map();
    const inventoryItemsById = new Map();
    const pendingChildrenByParent = new Map();
    const pendingMetaobjectIds = new Set();
    const metaobjectLookup = new Map();

    let lineCount = 0;
    let unresolvedChildCount = 0;
    let totalProductsProcessed = 0;
    let totalVariantsProcessed = 0;

    const collectMetaobjectRefs = (metafields = []) => {
      for (const metafield of metafields) {
        for (const id of extractMetaobjectIds(metafield?.value)) {
          if (!metaobjectLookup.has(id)) pendingMetaobjectIds.add(id);
        }
      }
    };

    const queuePendingChild = (child) => {
      unresolvedChildCount += 1;
      if (unresolvedChildCount > maxPendingChildren) {
        throw new Error(
          `MIRROR_PENDING_CHILD_LIMIT_EXCEEDED: ${maxPendingChildren}`,
        );
      }

      const parentId = String(child.__parentId || "");
      const rows = pendingChildrenByParent.get(parentId) || [];
      rows.push(child);
      pendingChildrenByParent.set(parentId, rows);
    };

    const retryPendingChildren = (parentId) => {
      const pending = pendingChildrenByParent.get(parentId);
      if (!pending?.length) return;

      const remaining = [];
      for (const child of pending) {
        const attached = attachChildToOwner({
          child,
          productsById,
          variantsById,
          inventoryItemsById,
          collectMetaobjectRefs,
        });

        if (attached) unresolvedChildCount -= 1;
        else remaining.push(child);
      }

      if (remaining.length > 0) {
        pendingChildrenByParent.set(parentId, remaining);
      } else {
        pendingChildrenByParent.delete(parentId);
      }
    };

    const flushMetaobjects = async () => {
      if (!session?.accessToken || pendingMetaobjectIds.size === 0) return;

      const ids = Array.from(pendingMetaobjectIds);
      pendingMetaobjectIds.clear();

      try {
        const resolved = await fetchMetaobjectLookupByIds(session, ids);
        for (const [gid, label] of resolved.entries()) {
          metaobjectLookup.set(gid, label);
        }
      } catch (error) {
        console.error("[sync:metaobject_lookup_failed]", {
          shop,
          syncBatchId,
          message: error.message,
        });
      }
    };

    const flushProducts = async (products) => {
      if (products.length === 0) return;
      await flushMetaobjects();

      const productRows = [];
      const variantRows = [];
      const inventoryItemRows = [];
      const inventoryLevelRows = [];
      const productCollectionRows = [];
      const metafieldRows = [];
      const productMediaRows = [];

      for (const product of products) {
        productRows.push(flattenProduct(product, shop, metaobjectLookup));

        for (const collection of product.collections || []) {
          if (!collection?.id) continue;
          productCollectionRows.push({
            shop,
            productId: product.id,
            collectionId: collection.id,
          });
        }

        for (const metafield of product.metafields || []) {
          if (!metafield?.namespace || !metafield?.key) continue;
          const typed = parseTypedMetafieldValue(
            metafield.type,
            metafield.value,
          );
          metafieldRows.push({
            shop,
            ownerType: "PRODUCT",
            ownerId: product.id,
            namespace: metafield.namespace,
            key: metafield.key,
            valueType: metafield.type || null,
            valueText: typed.valueText,
            valueTextNormalized: typed.valueTextNormalized,
            valueNumber: typed.valueNumber,
            valueBoolean: typed.valueBoolean,
            valueDate: typed.valueDate,
            valueJson:
              typeof metafield.value === "string"
                ? null
                : metafield.value,
          });
        }

        if (product.featuredMedia?.id) {
          productMediaRows.push({
            shop,
            productId: product.id,
            mediaId: product.featuredMedia.id,
            mediaType: product.featuredMedia.mediaContentType || "IMAGE",
            url:
              product.featuredMedia.image?.url ||
              product.featuredMedia.url ||
              null,
            alt:
              product.featuredMedia.image?.altText ||
              product.featuredMedia.alt ||
              null,
            position: product.featuredMedia.position ?? null,
            status: product.featuredMedia.status ?? null,
          });
        }

        for (const variant of product.variants || []) {
          if (!variant?.id) continue;

          const flattened = flattenVariant(product.id, variant, shop);
          variantRows.push(flattened);

          const inventoryItem = variant.inventoryItem || null;
          if (flattened.inventoryItemId) {
            inventoryItemRows.push({
              shop,
              id: flattened.inventoryItemId,
              variantId: flattened.id,
              productId: product.id,
              tracked: flattened.tracked ?? inventoryItem?.tracked ?? null,
              sku: flattened.sku ?? null,
              cost:
                flattened.cost ??
                inventoryItem?.unitCost?.amount ??
                null,
              countryCodeOfOrigin:
                flattened.countryOfOrigin ??
                inventoryItem?.countryCodeOfOrigin ??
                null,
              provinceCodeOfOrigin:
                inventoryItem?.provinceCodeOfOrigin ?? null,
              harmonizedSystemCode:
                flattened.hsTariffCode ??
                inventoryItem?.harmonizedSystemCode ??
                null,
            });

            const levels =
              inventoryItem?.inventoryLevels?.edges ||
              inventoryItem?.inventoryLevels?.nodes ||
              [];

            for (const wrapper of levels) {
              const level = wrapper?.node || wrapper;
              const locationId = level?.location?.id;
              if (!locationId) continue;

              const quantities = Array.isArray(level.quantities)
                ? level.quantities
                : [];
              const quantityByName = new Map(
                quantities.map((item) => [item.name, item.quantity]),
              );

              inventoryLevelRows.push({
                shop,
                inventoryItemId: flattened.inventoryItemId,
                locationId,
                available: quantityByName.get("available") ?? null,
                onHand: quantityByName.get("on_hand") ?? null,
                committed: quantityByName.get("committed") ?? null,
                incoming: quantityByName.get("incoming") ?? null,
                updatedAt: level.updatedAt
                  ? new Date(level.updatedAt)
                  : null,
              });
            }
          }

          for (const metafield of variant.metafields || []) {
            if (!metafield?.namespace || !metafield?.key) continue;
            const typed = parseTypedMetafieldValue(
              metafield.type,
              metafield.value,
            );
            metafieldRows.push({
              shop,
              ownerType: "VARIANT",
              ownerId: variant.id,
              namespace: metafield.namespace,
              key: metafield.key,
              valueType: metafield.type || null,
              valueText: typed.valueText,
              valueTextNormalized: typed.valueTextNormalized,
              valueNumber: typed.valueNumber,
              valueBoolean: typed.valueBoolean,
              valueDate: typed.valueDate,
              valueJson:
                typeof metafield.value === "string"
                  ? null
                  : metafield.value,
            });
          }
        }
      }

      await insertProductMirrorBatch({
        productRows,
        variantRows,
        inventoryItemRows,
        inventoryLevelRows,
        productCollectionRows,
        metafieldRows,
        productMediaRows,
        syncBatchId,
      });

      totalProductsProcessed += productRows.length;
      totalVariantsProcessed += variantRows.length;

      if (totalProductsProcessed % 5_000 === 0) {
        await updateInitialSyncProgress({
          shop,
          totalProductsProcessed,
        });
      }
    };

    const armStallTimer = () => {
      if (streamStallTimer) clearTimeout(streamStallTimer);
      streamStallTimer = setTimeout(() => {
        dataStream.destroy(
          new Error(
            `Product sync JSONL stream stalled for ${stallTimeoutMs}ms after ${lineCount} lines`,
          ),
        );
      }, stallTimeoutMs);
      streamStallTimer.unref?.();
    };

    const rl = readline.createInterface({
      input: dataStream,
      crlfDelay: Infinity,
    });

    armStallTimer();

    for await (const line of rl) {
      armStallTimer();
      if (!line.trim()) continue;
      lineCount += 1;

      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Product sync JSONL parse error at line ${lineCount}: ${error.message}`,
        );
      }

      if (!row.__parentId && row.__typename === "Product") {
        const product = createProductAccumulator(
          row,
          collectMetaobjectRefs,
        );
        productsById.set(String(product.id), product);
        retryPendingChildren(String(product.id));
      } else {
        const attached = attachChildToOwner({
          child: row,
          productsById,
          variantsById,
          inventoryItemsById,
          collectMetaobjectRefs,
        });

        if (!attached) queuePendingChild(row);
        if (row?.id) retryPendingChildren(String(row.id));
      }
    }

    if (streamStallTimer) clearTimeout(streamStallTimer);

    // A second deterministic resolution pass catches children that appeared
    // before their owner but whose owner arrived near the end of the stream.
    for (const parentId of [...pendingChildrenByParent.keys()]) {
      retryPendingChildren(parentId);
    }

    if (unresolvedChildCount > 0) {
      const samples = [...pendingChildrenByParent.entries()]
        .slice(0, 10)
        .map(([parentId, rows]) => ({
          parentId,
          childTypes: rows.slice(0, 5).map((row) => row.__typename),
        }));

      throw new Error(
        `MIRROR_UNRESOLVED_CHILDREN: count=${unresolvedChildCount} samples=${JSON.stringify(samples)}`,
      );
    }

    const allProducts = [...productsById.values()];
    for (let index = 0; index < allProducts.length; index += batchSize) {
      await flushProducts(allProducts.slice(index, index + batchSize));
    }

    const previousState = await db.store.findUnique({
      where: { shopUrl: shop },
      select: {
        activeMirrorBatchId: true,
        storeTotalProducts: true,
      },
    });

    const previousCount = Number(previousState?.storeTotalProducts || 0);
    const hasExistingMirror = Boolean(previousState?.activeMirrorBatchId);
    const threshold = getSuspiciousPartialSyncThreshold();

    if (
      totalProductsProcessed === 0 &&
      hasExistingMirror &&
      previousCount > 0
    ) {
      throw new Error(
        `Refusing empty mirror activation. previousCount=${previousCount}`,
      );
    }

    if (
      threshold > 0 &&
      hasExistingMirror &&
      previousCount > 0 &&
      totalProductsProcessed < previousCount * threshold
    ) {
      await recordMirrorAnomaly({
        shop,
        severity: "critical",
        type: "partial_product_sync_suspect",
        entityType: "mirrorBatch",
        entityId: syncBatchId,
        message:
          "Product sync parsed a suspiciously small replacement batch",
        details: {
          previousCount,
          totalProductsProcessed,
          threshold,
          lineCount,
        },
      }).catch(() => {});

      throw new Error(
        `Refusing suspicious partial mirror. current=${totalProductsProcessed} previous=${previousCount}`,
      );
    }

    await markMirrorBatchStatus({
      shop,
      syncBatchId,
      status: "VALIDATING_BATCH",
      counts: {
        actualProducts: totalProductsProcessed,
        actualVariants: totalVariantsProcessed,
      },
    });

    const finalized = await validateAndFinalizeProductMirrorBatch({
      shop,
      syncBatchId,
      unresolvedChildCount,
    });

    await activateProductMirrorBatch({
      shop,
      syncBatchId,
      expectedActiveBatchId:
        previousState?.activeMirrorBatchId ?? null,
      syncHistoryId,
    });

    return {
      totalProductsProcessed: finalized.productCount,
      totalVariantsProcessed: finalized.variantCount,
      syncBatchId,
    };
  } catch (error) {
    if (streamStallTimer) clearTimeout(streamStallTimer);

    await markSyncHistoryFailed({
      shop,
      syncHistoryId,
      errorMessage: error.message,
    });

    await markMirrorBatchStatus({
      shop,
      syncBatchId,
      status: "FAILED",
      failureReason: error.message,
    }).catch(() => {});

    throw error;
  }
}
