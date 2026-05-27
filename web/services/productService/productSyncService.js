import readline from "readline";
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
} from "./productSyncRepository.js";
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

function parseTypedMetafieldValue(rawType, rawValue) {
  const valueType = typeof rawType === "string" ? rawType.trim() : "";
  const textValue = rawValue === null || rawValue === undefined ? null : String(rawValue);
  const normalizedText = textValue ? textValue.trim().toLowerCase() : null;

  let valueNumber = null;
  let valueBoolean = null;
  let valueDate = null;

  if (textValue && ["number_integer", "number_decimal", "rating", "money"].includes(valueType)) {
    const parsed = Number(textValue);
    if (!Number.isNaN(parsed)) {
      valueNumber = parsed.toString();
    }
  }

  if (normalizedText === "true") valueBoolean = true;
  if (normalizedText === "false") valueBoolean = false;

  if (textValue && ["date", "date_time"].includes(valueType)) {
    const ms = Date.parse(textValue);
    if (!Number.isNaN(ms)) {
      valueDate = new Date(ms);
    }
  }

  return {
    valueText: textValue,
    valueTextNormalized: normalizedText,
    valueNumber,
    valueBoolean,
    valueDate,
  };
}

export async function startBulkOperationToFetchProducts({
  session,
  isInitialSync = false,
}) {
  console.log(`[sync:start] shop=${session.shop} isInitialSync=${isInitialSync}`);

  const { bulkOperationId, responseBody } = await runProductBulkFetch({ session });
  console.log(
    `[sync:bulk_created] shop=${session.shop} bulkOperationId=${bulkOperationId}`,
  );

  await markProductSyncStarted({ shop: session.shop });

  console.log(
    `[sync:queue_start] shop=${session.shop} bulkOperationId=${bulkOperationId}`,
  );

  const syncHistory = await queueProductSyncStart({
    shop: session.shop,
    bulkOperationId,
    isInitialSync,
  });

  console.log(
    `[sync:history_created] shop=${session.shop} syncHistoryId=${syncHistory.id} syncBatchId=${syncHistory.syncBatchId}`,
  );

  await clearProductSyncCache(session.shop);

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
  if (!syncBatchId) {
    throw new Error("syncBatchId is required for staged product sync");
  }

  console.log(`[sync:stream_start] shop=${shop} syncBatchId=${syncBatchId} syncHistoryId=${syncHistoryId}`);

  let metaobjectLookup = new Map();

  try {
    await markMirrorBatchStatus({
      shop,
      syncBatchId,
      status: "FILE_DOWNLOADED",
    });

    const PRODUCT_BATCH_SIZE = 1000;
    let productBatch = [];
    let totalProductsProcessed = 0;
    let totalVariantsProcessed = 0;
    let lineCount = 0;
    let currentProduct = null;
    const pendingMetaobjectIds = new Set();

    const collectMetaobjectRefsFromMetafields = (metafields = []) => {
      for (const metafield of metafields) {
        for (const id of extractMetaobjectIds(metafield?.value)) {
          if (!metaobjectLookup.has(id)) {
            pendingMetaobjectIds.add(id);
          }
        }
      }
    };

    const flushMetaobjectLookup = async () => {
      if (!session?.accessToken || pendingMetaobjectIds.size === 0) return;
      const ids = Array.from(pendingMetaobjectIds);
      pendingMetaobjectIds.clear();
      try {
        const resolved = await fetchMetaobjectLookupByIds(session, ids);
        for (const [gid, label] of resolved.entries()) {
          metaobjectLookup.set(gid, label);
        }
      } catch (error) {
        console.error(
          `Failed to resolve metaobject labels for shop ${shop}: ${error.message}`,
        );
      }
    };

    const normalizeProductNode = (node) => {
      const productMetafields = extractMetafields(node.metafields);
      collectMetaobjectRefsFromMetafields(productMetafields);
      return {
        ...node,
        variants: extractVariants(node.variants),
        metafields: productMetafields,
        collections: extractCollections(node.collections),
        options: Array.isArray(node.options) ? node.options : [],
        featuredMedia: node.featuredMedia || null,
      };
    };

    const flushProductsAndVariants = async () => {
      if (productBatch.length === 0) return;
      await flushMetaobjectLookup();

      const currentProducts = productBatch;
      productBatch = [];

      const productRows = [];
      const variantRows = [];
      const inventoryItemRows = [];
      const inventoryLevelRows = [];
      const productCollectionRows = [];
      const metafieldRows = [];

      for (const rawProduct of currentProducts) {
        productRows.push(flattenProduct(rawProduct, shop, metaobjectLookup));
        const productCollections = Array.isArray(rawProduct.collections)
          ? rawProduct.collections
          : [];
        const productMetafields = Array.isArray(rawProduct.metafields)
          ? rawProduct.metafields
          : [];

        for (const collection of productCollections) {
          if (!collection?.id) continue;
          productCollectionRows.push({
            shop,
            productId: rawProduct.id,
            collectionId: collection.id,
          });
        }

        for (const metafield of productMetafields) {
          if (!metafield?.namespace || !metafield?.key) continue;
          const typed = parseTypedMetafieldValue(metafield.type || null, metafield.value);
          metafieldRows.push({
            shop,
            ownerType: "PRODUCT",
            ownerId: rawProduct.id,
            namespace: metafield.namespace,
            key: metafield.key,
            valueType: metafield.type || null,
            valueText: typed.valueText,
            valueTextNormalized: typed.valueTextNormalized,
            valueNumber: typed.valueNumber,
            valueBoolean: typed.valueBoolean,
            valueDate: typed.valueDate,
            valueJson: typeof metafield.value === "string" ? null : metafield.value,
          });
        }

        const rawVariants = Array.isArray(rawProduct.variants)
          ? rawProduct.variants
          : [];

        for (const rawVariant of rawVariants) {
          if (!rawVariant?.id) continue;
          const flattenedVariant = flattenVariant(rawProduct.id, rawVariant, shop);
          variantRows.push(flattenedVariant);

          if (flattenedVariant.inventoryItemId) {
            inventoryItemRows.push({
              shop,
              id: flattenedVariant.inventoryItemId,
              variantId: flattenedVariant.id,
              productId: rawProduct.id,
              tracked: flattenedVariant.tracked ?? null,
              sku: flattenedVariant.sku ?? null,
              cost: flattenedVariant.cost ?? null,
              countryCodeOfOrigin: flattenedVariant.countryOfOrigin ?? null,
              harmonizedSystemCode: flattenedVariant.hsTariffCode ?? null,
            });
          }

          const variantMetafields = Array.isArray(rawVariant.metafields)
            ? rawVariant.metafields
            : [];
          for (const metafield of variantMetafields) {
            if (!metafield?.namespace || !metafield?.key) continue;
            const typed = parseTypedMetafieldValue(metafield.type || null, metafield.value);
            metafieldRows.push({
              shop,
              ownerType: "VARIANT",
              ownerId: rawVariant.id,
              namespace: metafield.namespace,
              key: metafield.key,
              valueType: metafield.type || null,
              valueText: typed.valueText,
              valueTextNormalized: typed.valueTextNormalized,
              valueNumber: typed.valueNumber,
              valueBoolean: typed.valueBoolean,
              valueDate: typed.valueDate,
              valueJson: typeof metafield.value === "string" ? null : metafield.value,
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
        syncBatchId,
      });

      totalProductsProcessed += productRows.length;
      totalVariantsProcessed += variantRows.length;

      console.log(`[sync:flush] shop=${shop} totalProductsProcessed=${totalProductsProcessed} totalVariantsProcessed=${totalVariantsProcessed}`);
      await markMirrorBatchStatus({
        shop,
        syncBatchId,
        status: "INGESTING_TO_STAGING_BATCH",
        counts: {
          actualProducts: totalProductsProcessed,
          actualVariants: totalVariantsProcessed,
        },
      });

      if (totalProductsProcessed > 0 && totalProductsProcessed % 5000 === 0) {
        await updateInitialSyncProgress({ shop, totalProductsProcessed });
      }
    };

    const rl = readline.createInterface({
      input: dataStream,
      crlfDelay: Infinity,
    });

    console.log(`[sync:staging_start] shop=${shop} syncBatchId=${syncBatchId}`);
    await stageProductMirrorBatch({ shop, syncBatchId, syncHistoryId });
    console.log(`[sync:staging_done] shop=${shop}`);

    const finalizeCurrentProduct = async () => {
      if (!currentProduct) return;
      productBatch.push(currentProduct);
      currentProduct = null;
      if (productBatch.length >= PRODUCT_BATCH_SIZE) {
        await flushProductsAndVariants();
      }
    };

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      // Log every 10k lines so you can see the stream is moving
      if (lineCount % 10000 === 0) {
        console.log(`[sync:stream_reading] shop=${shop} linesRead=${lineCount} productsMapSize=${productsMap.size}`);
      }

      let json;
      try {
        json = JSON.parse(line);
      } catch (error) {
        throw new Error(`Product sync JSONL parse error: ${error.message}`);
      }

      if (!json.__parentId && json.__typename === "Product") {
        await finalizeCurrentProduct();
        currentProduct = normalizeProductNode(json);
        continue;
      }

      const parent = currentProduct && currentProduct.id === json.__parentId
        ? currentProduct
        : null;
      if (!parent) continue;

      switch (json.__typename) {
        case "ProductVariant":
          parent.variants.push({
            id: json.id,
            title: json.title,
            sku: json.sku,
            barcode: json.barcode,
            price: json.price,
            compareAtPrice: json.compareAtPrice,
            inventoryQuantity: json.inventoryQuantity,
            inventoryPolicy: json.inventoryPolicy,
            taxable: json.taxable,
            taxCode: json.taxCode,
            position: json.position,
            selectedOptions: Array.isArray(json.selectedOptions)
              ? json.selectedOptions
              : [],
            inventoryItem: json.inventoryItem || null,
          });
          break;

        case "Collection":
          parent.collections.push({
            id: json.id,
            title: json.title,
          });
          break;

        case "Metafield":
          parent.metafields.push({
            namespace: json.namespace,
            key: json.key,
            type: json.type,
            value: json.value,
          });
          collectMetaobjectRefsFromMetafields([json]);
          break;

        case "MediaImage":
          parent.featuredMedia = json;
          break;

        default:
          break;
      }
    }
    await finalizeCurrentProduct();
    await flushProductsAndVariants();
    console.log(`[sync:stream_done] shop=${shop} totalLinesRead=${lineCount} totalProducts=${totalProductsProcessed}`);

    console.log(`[sync:activating] shop=${shop} syncBatchId=${syncBatchId} totalProductsProcessed=${totalProductsProcessed}`);

    await markMirrorBatchStatus({
      shop,
      syncBatchId,
      status: "VALIDATING_BATCH",
      counts: {
        actualProducts: totalProductsProcessed,
        actualVariants: totalVariantsProcessed,
      },
    });

    await markMirrorBatchStatus({
      shop,
      syncBatchId,
      status: "ACTIVATING_BATCH",
      counts: {
        actualProducts: totalProductsProcessed,
        actualVariants: totalVariantsProcessed,
      },
    });


    await activateProductMirrorBatch({
      shop,
      syncBatchId,
      totalProductsProcessed,
      totalVariantsProcessed,
      syncHistoryId,
    });

    console.log(`[sync:complete] shop=${shop} syncBatchId=${syncBatchId} totalProductsProcessed=${totalProductsProcessed} totalVariantsProcessed=${totalVariantsProcessed}`);


    return {
      totalProductsProcessed,
      totalVariantsProcessed,
      syncBatchId,
    };
  } catch (error) {
     console.error(`[sync:failed] shop=${shop} syncBatchId=${syncBatchId} syncHistoryId=${syncHistoryId} error=${error.message}`);
    console.error(error.stack);
    
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
    });
    throw error;
  }
}
