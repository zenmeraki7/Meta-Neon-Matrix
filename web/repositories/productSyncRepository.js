import { prisma } from "../config/database.js";
import { addProductMirrorBatchCleanupJob } from "../Jobs/Queues/productMirrorBatchCleanupJob.js";
import { clearKeyCaches } from "../utils/cacheUtils.js";
import { getProductSyncCacheKeys } from "../utils/cacheKeyRegistry.js";
import {
  createMirrorBatchId,
  markFullSyncStarted,
} from "../services/mirrorHealthService.js";

async function transitionMirrorSyncLedgerBySyncHistoryId(tx, {
  shop,
  syncHistoryId,
  from,
  to,
  data = {},
}) {
  if (!shop || !syncHistoryId) return 0;
  const updated = await tx.operationFingerprint.updateMany({
    where: {
      shop,
      operationType: "MIRROR_SYNC",
      resourceType: "sync_history",
      resourceId: String(syncHistoryId),
      status: Array.isArray(from) ? { in: from } : from,
    },
    data: {
      status: to,
      ...data,
      updatedAt: new Date(),
    },
  });
  return Number(updated?.count || 0);
}

async function upsertMirrorBatch(tx, {
  id,
  shop,
  syncHistoryId = null,
  bulkOperationId = null,
  resourceType = "PRODUCT_CATALOG",
  status = "SYNC_REQUESTED",
}) {
  if (!id || !shop) {
    throw new Error("upsertMirrorBatch requires id and shop");
  }

  const data = {
    shop,
    syncHistoryId,
    bulkOperationId,
    resourceType,
    status,
    failureReason: null,
    failedAt: null,
  };

  return tx.mirrorBatch.upsert({
    where: {
      shop_id: {
        shop,
        id,
      },
    },
    create: {
      id,
      ...data,
    },
    update: data,
  });
}

function assertRowsBelongToShop(rows, { shop, syncBatchId, label }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new Error(`${label}[${index}] must be an object`);
    }
    if (row.shop && row.shop !== shop) {
      throw new Error(`${label}[${index}] shop mismatch`);
    }
    if (row.mirrorBatchId && row.mirrorBatchId !== syncBatchId) {
      throw new Error(`${label}[${index}] mirrorBatchId mismatch`);
    }
    return {
      ...row,
      shop,
      mirrorBatchId: syncBatchId,
    };
  });
}

async function deleteMirrorBatchRows(tx, { shop, mirrorBatchId }) {
  await tx.variant.deleteMany({
    where: { shop, mirrorBatchId },
  });
  await tx.inventoryLevelMirror.deleteMany({
    where: { shop, mirrorBatchId },
  });
  await tx.inventoryItemMirror.deleteMany({
    where: { shop, mirrorBatchId },
  });
  await tx.productCollection.deleteMany({
    where: { shop, mirrorBatchId },
  });
  await tx.metafieldMirror.deleteMany({
    where: { shop, mirrorBatchId },
  });
  await tx.productMediaMirror.deleteMany({
    where: { shop, mirrorBatchId },
  });
  await tx.product.deleteMany({
    where: { shop, mirrorBatchId },
  });
}

async function cleanupMirrorBatchProductChunk({ shop, previousBatchId, chunkSize }) {
  const result = await prisma.$queryRaw`
    WITH product_chunk AS (
      SELECT "id"
      FROM "Product"
      WHERE "shop" = ${shop}
        AND "mirrorBatchId" = ${previousBatchId}
      ORDER BY "id"
      LIMIT ${chunkSize}
    ),
    variant_chunk AS (
      SELECT "id"
      FROM "Variant"
      WHERE "shop" = ${shop}
        AND "mirrorBatchId" = ${previousBatchId}
        AND "productId" IN (SELECT "id" FROM product_chunk)
    ),
    inventory_item_chunk AS (
      SELECT "id"
      FROM "InventoryItemMirror"
      WHERE "shop" = ${shop}
        AND "mirrorBatchId" = ${previousBatchId}
        AND "productId" IN (SELECT "id" FROM product_chunk)
    ),
    deleted_levels AS (
      DELETE FROM "InventoryLevelMirror" level
      USING inventory_item_chunk item
      WHERE level."shop" = ${shop}
        AND level."mirrorBatchId" = ${previousBatchId}
        AND level."inventoryItemId" = item."id"
      RETURNING level."inventoryItemId"
    ),
    deleted_items AS (
      DELETE FROM "InventoryItemMirror" item
      USING product_chunk product
      WHERE item."shop" = ${shop}
        AND item."mirrorBatchId" = ${previousBatchId}
        AND item."productId" = product."id"
      RETURNING item."id"
    ),
    deleted_collections AS (
      DELETE FROM "ProductCollection" collection
      USING product_chunk product
      WHERE collection."shop" = ${shop}
        AND collection."mirrorBatchId" = ${previousBatchId}
        AND collection."productId" = product."id"
      RETURNING collection."productId"
    ),
    deleted_media AS (
      DELETE FROM "ProductMediaMirror" media
      USING product_chunk product
      WHERE media."shop" = ${shop}
        AND media."mirrorBatchId" = ${previousBatchId}
        AND media."productId" = product."id"
      RETURNING media."productId"
    ),
    deleted_metafields AS (
      DELETE FROM "MetafieldMirror" metafield
      WHERE metafield."shop" = ${shop}
        AND metafield."mirrorBatchId" = ${previousBatchId}
        AND (
          (
            metafield."ownerType" = 'PRODUCT'
            AND metafield."ownerId" IN (SELECT "id" FROM product_chunk)
          )
          OR (
            metafield."ownerType" = 'VARIANT'
            AND metafield."ownerId" IN (SELECT "id" FROM variant_chunk)
          )
        )
      RETURNING metafield."ownerId"
    ),
    deleted_variants AS (
      DELETE FROM "Variant" variant
      USING product_chunk product
      WHERE variant."shop" = ${shop}
        AND variant."mirrorBatchId" = ${previousBatchId}
        AND variant."productId" = product."id"
      RETURNING variant."id"
    ),
    deleted_products AS (
      DELETE FROM "Product" product
      USING product_chunk chunk
      WHERE product."shop" = ${shop}
        AND product."mirrorBatchId" = ${previousBatchId}
        AND product."id" = chunk."id"
      RETURNING product."id"
    )
    SELECT COUNT(*)::int AS "deletedProducts" FROM deleted_products
  `;
  return Number(result?.[0]?.deletedProducts || 0);
}

export async function cleanupPreviousMirrorBatch({ shop, previousBatchId }) {
  if (!shop || !previousBatchId) return;
  const chunkSize = Math.max(
    100,
    Math.min(Number(process.env.PRODUCT_MIRROR_BATCH_CLEANUP_CHUNK_SIZE || 5000), 25000),
  );

  let deletedProducts = 0;
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const deletedInChunk = await cleanupMirrorBatchProductChunk({
      shop,
      previousBatchId,
      chunkSize,
    });
    if (deletedInChunk <= 0) break;
    deletedProducts += deletedInChunk;
  }

  await prisma.$transaction(async (tx) => {
    await deleteMirrorBatchRows(tx, {
      shop,
      mirrorBatchId: previousBatchId,
    });
    await tx.mirrorBatch.updateMany({
      where: { id: previousBatchId, shop },
      data: { status: "RETIRED" },
    });
  });

  return { deletedProducts };
}

async function preserveNewerPreviousBatchProducts({
  shop,
  previousBatchId,
  syncBatchId,
}) {
  if (!shop || !previousBatchId || !syncBatchId || previousBatchId === syncBatchId) {
    return 0;
  }

  const result = await prisma.$queryRaw`
    WITH candidate_products AS (
      SELECT previous_product."id"
      FROM "Product" previous_product
      LEFT JOIN "Product" staged_product
        ON staged_product."shop" = previous_product."shop"
       AND staged_product."id" = previous_product."id"
       AND staged_product."mirrorBatchId" = ${syncBatchId}
      WHERE previous_product."shop" = ${shop}
        AND previous_product."mirrorBatchId" = ${previousBatchId}
        AND (
          staged_product."id" IS NULL
          OR (
            previous_product."lastSourceUpdatedAt" IS NOT NULL
            AND (
              staged_product."lastSourceUpdatedAt" IS NULL
              OR previous_product."lastSourceUpdatedAt" > staged_product."lastSourceUpdatedAt"
            )
          )
        )
    ),
    candidate_variants AS (
      SELECT previous_variant."id", previous_variant."productId"
      FROM "Variant" previous_variant
      JOIN candidate_products candidate_product
        ON candidate_product."id" = previous_variant."productId"
      WHERE previous_variant."shop" = ${shop}
        AND previous_variant."mirrorBatchId" = ${previousBatchId}
    ),
    candidate_inventory_items AS (
      SELECT previous_item."id"
      FROM "InventoryItemMirror" previous_item
      JOIN candidate_products candidate_product
        ON candidate_product."id" = previous_item."productId"
      WHERE previous_item."shop" = ${shop}
        AND previous_item."mirrorBatchId" = ${previousBatchId}
    ),
    deleted_levels AS (
      DELETE FROM "InventoryLevelMirror" staged
      USING candidate_inventory_items candidate_item
      WHERE staged."shop" = ${shop}
        AND staged."mirrorBatchId" = ${syncBatchId}
        AND staged."inventoryItemId" = candidate_item."id"
      RETURNING staged."inventoryItemId"
    ),
    deleted_items AS (
      DELETE FROM "InventoryItemMirror" staged
      USING candidate_products candidate_product
      WHERE staged."shop" = ${shop}
        AND staged."mirrorBatchId" = ${syncBatchId}
        AND staged."productId" = candidate_product."id"
      RETURNING staged."id"
    ),
    deleted_collections AS (
      DELETE FROM "ProductCollection" staged
      USING candidate_products candidate_product
      WHERE staged."shop" = ${shop}
        AND staged."mirrorBatchId" = ${syncBatchId}
        AND staged."productId" = candidate_product."id"
      RETURNING staged."productId"
    ),
    deleted_media AS (
      DELETE FROM "ProductMediaMirror" staged
      USING candidate_products candidate_product
      WHERE staged."shop" = ${shop}
        AND staged."mirrorBatchId" = ${syncBatchId}
        AND staged."productId" = candidate_product."id"
      RETURNING staged."productId"
    ),
    deleted_metafields AS (
      DELETE FROM "MetafieldMirror" staged
      WHERE staged."shop" = ${shop}
        AND staged."mirrorBatchId" = ${syncBatchId}
        AND (
          (
            staged."ownerType" = 'PRODUCT'
            AND staged."ownerId" IN (SELECT "id" FROM candidate_products)
          )
          OR (
            staged."ownerType" = 'VARIANT'
            AND staged."ownerId" IN (SELECT "id" FROM candidate_variants)
          )
        )
      RETURNING staged."ownerId"
    ),
    deleted_variants AS (
      DELETE FROM "Variant" staged
      USING candidate_products candidate_product
      WHERE staged."shop" = ${shop}
        AND staged."mirrorBatchId" = ${syncBatchId}
        AND staged."productId" = candidate_product."id"
      RETURNING staged."id"
    ),
    deleted_products AS (
      DELETE FROM "Product" staged
      USING candidate_products candidate_product
      WHERE staged."shop" = ${shop}
        AND staged."mirrorBatchId" = ${syncBatchId}
        AND staged."id" = candidate_product."id"
      RETURNING staged."id"
    ),
    inserted_products AS (
      INSERT INTO "Product" (
        "shop", "id", "mirrorBatchId", "title", "handle", "status", "statusNormalized",
        "productType", "vendor", "tags", "templateSuffix", "descriptionHtml", "descriptionText",
        "createdAt", "updatedAt", "publishedAt", "seoTitle", "seoDescription", "totalInventory",
        "categoryId", "categoryName", "googleShoppingEnabled", "googleShoppingAgeGroup",
        "googleShoppingCategory", "googleShoppingColor", "googleShoppingCondition",
        "googleShoppingCustomLabel0", "googleShoppingCustomLabel1", "googleShoppingCustomLabel2",
        "googleShoppingCustomLabel3", "googleShoppingCustomLabel4", "googleShoppingCustomProduct",
        "googleShoppingGender", "googleShoppingMpn", "googleShoppingMaterial", "googleShoppingSize",
        "googleShoppingSizeSystem", "googleShoppingSizeType", "categoryAgeGroup", "categoryColor",
        "categoryFabric", "categoryFit", "categorySize", "categoryTargetGender", "categoryWaistRise",
        "featuredImageUrl", "featuredImageAltText", "optionsJson", "collectionsJson", "option1Name",
        "option2Name", "option3Name", "variantCount", "visibleOnlineStore", "lastSourceUpdatedAt",
        "lastSourceEventAt", "lastSourceKind", "lastReconciledAt"
      )
      SELECT
        "shop", "id", ${syncBatchId}, "title", "handle", "status", "statusNormalized",
        "productType", "vendor", "tags", "templateSuffix", "descriptionHtml", "descriptionText",
        "createdAt", "updatedAt", "publishedAt", "seoTitle", "seoDescription", "totalInventory",
        "categoryId", "categoryName", "googleShoppingEnabled", "googleShoppingAgeGroup",
        "googleShoppingCategory", "googleShoppingColor", "googleShoppingCondition",
        "googleShoppingCustomLabel0", "googleShoppingCustomLabel1", "googleShoppingCustomLabel2",
        "googleShoppingCustomLabel3", "googleShoppingCustomLabel4", "googleShoppingCustomProduct",
        "googleShoppingGender", "googleShoppingMpn", "googleShoppingMaterial", "googleShoppingSize",
        "googleShoppingSizeSystem", "googleShoppingSizeType", "categoryAgeGroup", "categoryColor",
        "categoryFabric", "categoryFit", "categorySize", "categoryTargetGender", "categoryWaistRise",
        "featuredImageUrl", "featuredImageAltText", "optionsJson", "collectionsJson", "option1Name",
        "option2Name", "option3Name", "variantCount", "visibleOnlineStore", "lastSourceUpdatedAt",
        "lastSourceEventAt", "lastSourceKind", "lastReconciledAt"
      FROM "Product"
      WHERE "shop" = ${shop}
        AND "mirrorBatchId" = ${previousBatchId}
        AND "id" IN (SELECT "id" FROM candidate_products)
      ON CONFLICT DO NOTHING
      RETURNING "id"
    ),
    inserted_variants AS (
      INSERT INTO "Variant" (
        "shop", "id", "productId", "mirrorBatchId", "inventoryItemId", "title", "sku", "barcode",
        "price", "compareAtPrice", "inventoryQuantity", "inventoryPolicy", "taxable", "taxCode",
        "position", "selectedOptionsJson", "cost", "countryOfOrigin", "hsTariffCode", "weight",
        "weightUnit", "option1Value", "option2Value", "option3Value", "physicalProduct",
        "profitMargin", "tracked"
      )
      SELECT previous_variant."shop", previous_variant."id", previous_variant."productId", ${syncBatchId},
        previous_variant."inventoryItemId", previous_variant."title", previous_variant."sku",
        previous_variant."barcode", previous_variant."price", previous_variant."compareAtPrice",
        previous_variant."inventoryQuantity", previous_variant."inventoryPolicy", previous_variant."taxable",
        previous_variant."taxCode", previous_variant."position", previous_variant."selectedOptionsJson",
        previous_variant."cost", previous_variant."countryOfOrigin", previous_variant."hsTariffCode",
        previous_variant."weight", previous_variant."weightUnit", previous_variant."option1Value",
        previous_variant."option2Value", previous_variant."option3Value", previous_variant."physicalProduct",
        previous_variant."profitMargin", previous_variant."tracked"
      FROM "Variant" previous_variant
      JOIN candidate_variants candidate_variant
        ON candidate_variant."id" = previous_variant."id"
      WHERE previous_variant."shop" = ${shop}
        AND previous_variant."mirrorBatchId" = ${previousBatchId}
      ON CONFLICT DO NOTHING
      RETURNING "id"
    ),
    inserted_inventory_items AS (
      INSERT INTO "InventoryItemMirror"
      SELECT previous_item."shop", previous_item."id", previous_item."variantId", previous_item."productId",
        ${syncBatchId}, previous_item."tracked", previous_item."sku", previous_item."cost",
        previous_item."countryCodeOfOrigin", previous_item."provinceCodeOfOrigin",
        previous_item."harmonizedSystemCode", previous_item."createdAt", previous_item."updatedAt"
      FROM "InventoryItemMirror" previous_item
      JOIN candidate_inventory_items candidate_item
        ON candidate_item."id" = previous_item."id"
      WHERE previous_item."shop" = ${shop}
        AND previous_item."mirrorBatchId" = ${previousBatchId}
      ON CONFLICT DO NOTHING
      RETURNING "id"
    ),
    inserted_inventory_levels AS (
      INSERT INTO "InventoryLevelMirror"
      SELECT previous_level."shop", previous_level."inventoryItemId", previous_level."locationId",
        ${syncBatchId}, previous_level."available", previous_level."onHand", previous_level."committed",
        previous_level."incoming", previous_level."updatedAt", previous_level."createdAt"
      FROM "InventoryLevelMirror" previous_level
      JOIN candidate_inventory_items candidate_item
        ON candidate_item."id" = previous_level."inventoryItemId"
      WHERE previous_level."shop" = ${shop}
        AND previous_level."mirrorBatchId" = ${previousBatchId}
      ON CONFLICT DO NOTHING
      RETURNING "inventoryItemId"
    ),
    inserted_collections AS (
      INSERT INTO "ProductCollection" (
        "shop", "productId", "collectionId", "mirrorBatchId", "createdAt"
      )
      SELECT previous_collection."shop", previous_collection."productId", previous_collection."collectionId",
        ${syncBatchId}, previous_collection."createdAt"
      FROM "ProductCollection" previous_collection
      JOIN candidate_products candidate_product
        ON candidate_product."id" = previous_collection."productId"
      WHERE previous_collection."shop" = ${shop}
        AND previous_collection."mirrorBatchId" = ${previousBatchId}
      ON CONFLICT DO NOTHING
      RETURNING "productId"
    ),
    inserted_media AS (
      INSERT INTO "ProductMediaMirror"
      SELECT previous_media."shop", previous_media."productId", previous_media."mediaId", ${syncBatchId},
        previous_media."mediaType", previous_media."url", previous_media."alt", previous_media."position",
        previous_media."status", previous_media."createdAt", previous_media."updatedAt"
      FROM "ProductMediaMirror" previous_media
      JOIN candidate_products candidate_product
        ON candidate_product."id" = previous_media."productId"
      WHERE previous_media."shop" = ${shop}
        AND previous_media."mirrorBatchId" = ${previousBatchId}
      ON CONFLICT DO NOTHING
      RETURNING "productId"
    ),
    inserted_metafields AS (
      INSERT INTO "MetafieldMirror" (
        "shop", "ownerType", "ownerId", "namespace", "key", "valueType", "valueText",
        "valueTextNormalized", "valueNumber", "valueBoolean", "valueDate", "valueJson",
        "mirrorBatchId", "updatedAt"
      )
      SELECT previous_metafield."shop", previous_metafield."ownerType", previous_metafield."ownerId",
        previous_metafield."namespace", previous_metafield."key",
        previous_metafield."valueType", previous_metafield."valueText", previous_metafield."valueTextNormalized",
        previous_metafield."valueNumber", previous_metafield."valueBoolean", previous_metafield."valueDate",
        previous_metafield."valueJson", ${syncBatchId}, previous_metafield."updatedAt"
      FROM "MetafieldMirror" previous_metafield
      WHERE previous_metafield."shop" = ${shop}
        AND previous_metafield."mirrorBatchId" = ${previousBatchId}
        AND (
          (
            previous_metafield."ownerType" = 'PRODUCT'
            AND previous_metafield."ownerId" IN (SELECT "id" FROM candidate_products)
          )
          OR (
            previous_metafield."ownerType" = 'VARIANT'
            AND previous_metafield."ownerId" IN (SELECT "id" FROM candidate_variants)
          )
        )
      ON CONFLICT DO NOTHING
      RETURNING "ownerId"
    )
    SELECT COUNT(*)::int AS preserved FROM inserted_products
  `;

  return getPreservedCount(result);
}

function getPreservedCount(result) {
  if (Array.isArray(result)) {
    return Number(result[0]?.preserved || 0);
  }
  return Number(result || 0);
}

async function readActiveMirrorBatchIdForUpdate(tx, { shop }) {
  const rows = await tx.$queryRaw`
    SELECT "activeMirrorBatchId"
    FROM "Store"
    WHERE "shopUrl" = ${shop}
    FOR UPDATE
  `;
  return rows?.[0]?.activeMirrorBatchId || null;
}

export async function markMirrorBatchStatus({
  shop,
  syncBatchId,
  status,
  failureReason = null,
  counts = {},
}) {
  if (!syncBatchId) return;

  const data = {
    status,
    ...(failureReason ? { failureReason } : {}),
    ...(status === "FAILED" ? { failedAt: new Date() } : {}),
    ...(status === "ACTIVE" ? { activatedAt: new Date() } : {}),
    ...(typeof counts.actualProducts === "number" ? { actualProducts: counts.actualProducts } : {}),
    ...(typeof counts.actualVariants === "number" ? { actualVariants: counts.actualVariants } : {}),
    ...(typeof counts.actualCollections === "number" ? { actualCollections: counts.actualCollections } : {}),
    ...(typeof counts.actualMetafields === "number" ? { actualMetafields: counts.actualMetafields } : {}),
  };

  await prisma.mirrorBatch.updateMany({
    where: { id: syncBatchId, shop },
    data,
  });
}

export async function markProductSyncStarted({ shop }) {
  await markFullSyncStarted(shop);
}

export async function queueProductSyncStart({
  shop,
  bulkOperationId,
  isInitialSync = false,
}) {
  if (!shop || !bulkOperationId) {
    throw new Error("queueProductSyncStart requires shop and bulkOperationId");
  }

  const existingHistory = await prisma.syncHistory.findFirst({
    where: {
      shop,
      bulkOperationId,
      operationType: "Product",
      status: "processing",
    },
    orderBy: { createdAt: "desc" },
  });
  if (existingHistory) {
    return existingHistory;
  }

  const syncBatchId = createMirrorBatchId("product_sync");

  let syncHistory;
  try {
    syncHistory = await prisma.$transaction(async (tx) => {
      await tx.store.update({
        where: { shopUrl: shop },
        data: {
          isProductSyncing: true,
          isProductInitialySyning: isInitialSync,
          shopifyBulkJobCompleted: false,
          syncProgressStage: "SHOPIFY_BULK_RUNNING",
          staleReason: "FULL_SYNC_RUNNING",
          lastSyncErrorSummary: null,
          mirrorUnsafeSince: new Date(),
        },
      });

      const createdHistory = await tx.syncHistory.create({
        data: {
          shop,
          bulkOperationId,
          syncBatchId,
          status: "processing",
          stage: "SHOPIFY_BULK_RUNNING",
          operationType: "Product",
          isInitialProductSync: isInitialSync,
          recordCount: 0,
          duration: 0,
        },
      });

      await upsertMirrorBatch(tx, {
        id: syncBatchId,
        shop,
        syncHistoryId: createdHistory.id,
        bulkOperationId,
        resourceType: "PRODUCT_CATALOG",
        status: "BULK_OPERATION_STARTED",
      });

      return createdHistory;
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    syncHistory = await prisma.syncHistory.findFirst({
      where: {
        shop,
        bulkOperationId,
        operationType: "Product",
      },
      orderBy: { createdAt: "desc" },
    });
    if (!syncHistory) throw error;
  }

  return syncHistory;
}

export async function clearProductSyncCache(shop) {
  await Promise.all(getProductSyncCacheKeys(shop).map((key) => clearKeyCaches(key)));
}

export async function stageProductMirrorBatch({
  shop,
  syncBatchId,
  syncHistoryId = null,
}) {
  await prisma.$transaction(async (tx) => {
    await deleteMirrorBatchRows(tx, {
      shop,
      mirrorBatchId: syncBatchId,
    });

    await tx.store.update({
      where: { shopUrl: shop },
      data: {
        syncProgressStage: "MIRROR_STAGING",
        staleReason: "FULL_SYNC_RUNNING",
      },
    });

    if (syncHistoryId) {
      await tx.syncHistory.updateMany({
        where: { id: syncHistoryId, shop },
        data: {
          stage: "MIRROR_STAGING",
        },
      });
    }

    await upsertMirrorBatch(tx, {
      id: syncBatchId,
      shop,
      syncHistoryId,
      resourceType: "PRODUCT_CATALOG",
      status: "INGESTING_TO_STAGING_BATCH",
    });
    await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
      shop,
      syncHistoryId,
      from: ["RUNNING", "STARTING_BULK_QUERY"],
      to: "INGESTING",
    });
  });
}

export async function insertProductMirrorBatch({
  shop,
  productRows,
  variantRows,
  inventoryItemRows,
  inventoryLevelRows,
  productCollectionRows,
  metafieldRows,
  syncBatchId,
}) {
  if (!shop || !syncBatchId) {
    throw new Error("insertProductMirrorBatch requires shop and syncBatchId");
  }

  const scopedProductRows = assertRowsBelongToShop(productRows, {
    shop,
    syncBatchId,
    label: "productRows",
  });
  const scopedVariantRows = assertRowsBelongToShop(variantRows, {
    shop,
    syncBatchId,
    label: "variantRows",
  });
  const scopedInventoryItemRows = assertRowsBelongToShop(inventoryItemRows, {
    shop,
    syncBatchId,
    label: "inventoryItemRows",
  });
  const scopedInventoryLevelRows = assertRowsBelongToShop(inventoryLevelRows, {
    shop,
    syncBatchId,
    label: "inventoryLevelRows",
  });
  const scopedProductCollectionRows = assertRowsBelongToShop(productCollectionRows, {
    shop,
    syncBatchId,
    label: "productCollectionRows",
  });
  const scopedMetafieldRows = assertRowsBelongToShop(metafieldRows, {
    shop,
    syncBatchId,
    label: "metafieldRows",
  });

  const mirrorBatch = await prisma.mirrorBatch.findFirst({
    where: { id: syncBatchId, shop },
    select: { id: true },
  });
  if (!mirrorBatch) {
    throw new Error("MIRROR_BATCH_NOT_FOUND_FOR_SHOP");
  }

  if (scopedProductRows.length > 0) {
    await prisma.product.createMany({
      data: scopedProductRows,
      skipDuplicates: true,
    });
  }

  if (scopedVariantRows.length > 0) {
    await prisma.variant.createMany({
      data: scopedVariantRows,
      skipDuplicates: true,
    });
  }

  if (scopedInventoryItemRows.length > 0) {
    await prisma.inventoryItemMirror.createMany({
      data: scopedInventoryItemRows,
      skipDuplicates: true,
    });
  }

  if (scopedInventoryLevelRows.length > 0) {
    await prisma.inventoryLevelMirror.createMany({
      data: scopedInventoryLevelRows,
      skipDuplicates: true,
    });
  }

  if (scopedProductCollectionRows.length > 0) {
    await prisma.productCollection.createMany({
      data: scopedProductCollectionRows,
      skipDuplicates: true,
    });
  }

  if (scopedMetafieldRows.length > 0) {
    await prisma.metafieldMirror.createMany({
      data: scopedMetafieldRows,
      skipDuplicates: true,
    });
  }
}

export async function markSyncHistoryFailed({
  shop,
  syncHistoryId,
  errorMessage,
}) {
  await prisma.$transaction(async (tx) => {
    if (syncHistoryId) {
      const syncHistory = await tx.syncHistory.findFirst({
        where: { id: syncHistoryId, shop },
      });
      if (!syncHistory) {
        throw new Error("SYNC_HISTORY_NOT_FOUND");
      }
      const updatedSyncHistoryResult = await tx.syncHistory.updateMany({
        where: {
          id: syncHistoryId,
          shop,
          status: "processing",
          stage: {
            in: [
              "SHOPIFY_BULK_RUNNING",
              "MIRROR_DOWNLOAD_STARTED",
              "MIRROR_STAGING",
              "INGESTING_TO_STAGING_BATCH",
              "VALIDATING_BATCH",
              "ACTIVATING_BATCH",
              "ACTIVE",
            ],
          },
        },
        data: {
          status: "failed",
          stage: "FAILED",
          errorMessage,
        },
      });
      if (updatedSyncHistoryResult.count !== 1) {
        return;
      }

      if (syncHistory.syncBatchId) {
        await upsertMirrorBatch(tx, {
          id: syncHistory.syncBatchId,
          shop,
          syncHistoryId: syncHistory.id,
          bulkOperationId: syncHistory.bulkOperationId || null,
          resourceType: "PRODUCT_CATALOG",
          status: "FAILED",
        });
        await tx.mirrorBatch.updateMany({
          where: {
            id: syncHistory.syncBatchId,
            shop,
            status: {
              in: [
                "SYNC_REQUESTED",
                "BULK_OPERATION_STARTED",
                "FILE_DOWNLOADED",
                "INGESTING_TO_STAGING_BATCH",
                "VALIDATING_BATCH",
                "ACTIVATING_BATCH",
              ],
            },
          },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            failureReason: errorMessage,
          },
        });
      }

      await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
        shop,
        syncHistoryId: syncHistory.id,
        from: ["QUEUED", "STARTING_BULK_QUERY", "RUNNING", "INGESTING"],
        to: "FAILED",
        data: { lastError: errorMessage || null },
      });
    }

    if (shop) {
      await tx.store.update({
        where: { shopUrl: shop },
        data: {
          isProductSyncing: false,
          isProductInitialySyning: false,
          syncProgressStage: "IDLE",
          mirrorHealthState: "UNSAFE",
          staleReason: "FULL_SYNC_FAILED",
          repairRequired: true,
          mirrorUnsafeSince: new Date(),
          lastSyncErrorSummary: errorMessage,
        },
      });
    }
  });
  if (shop) {
    await clearProductSyncCache(shop);
  }
}

export async function activateProductMirrorBatch({
  shop,
  syncBatchId,
  syncHistoryId,
}) {
  let previousBatchId = null;
  const completedAt = new Date();
  const maxActivationAttempts = 3;

  for (let attempt = 1; attempt <= maxActivationAttempts; attempt += 1) {
    const store = await prisma.store.findUnique({
      where: { shopUrl: shop },
      select: { activeMirrorBatchId: true },
    });
    previousBatchId = store?.activeMirrorBatchId || null;
    if (previousBatchId && previousBatchId !== syncBatchId) {
      await preserveNewerPreviousBatchProducts({
        shop,
        previousBatchId,
        syncBatchId,
      });
    }

    const activated = await prisma.$transaction(async (tx) => {
    const lockedPreviousBatchId = await readActiveMirrorBatchIdForUpdate(tx, { shop });
    if (lockedPreviousBatchId !== previousBatchId) {
      return false;
    }

    const finalProductCount = await tx.product.count({ where: { shop, mirrorBatchId: syncBatchId } });
    const finalVariantCount = await tx.variant.count({ where: { shop, mirrorBatchId: syncBatchId } });

    const storeActivated = await tx.store.updateMany({
      where: {
        shopUrl: shop,
        isProductSyncing: true,
      },
      data: {
        activeMirrorBatchId: syncBatchId,
        mirrorHealthState: "HEALTHY",
        staleReason: null,
        repairRequired: false,
        mirrorUnsafeSince: null,
        lastSyncErrorSummary: null,
        lastFullSyncAt: completedAt,
        isProductSyncing: false,
        isProductInitialySyning: false,
        syncProgressStage: "IDLE",
        shopifyBulkJobCompleted: true,
        storeTotalProducts: finalProductCount,
        productInitialSyncProgress: finalProductCount,
        lastProductSyncAt: completedAt,
      },
    });
    if (storeActivated.count !== 1) {
      throw new Error("STORE_SYNC_ACTIVATION_TRANSITION_REJECTED");
    }

    if (syncHistoryId) {
      const updatedSyncHistory = await tx.syncHistory.updateMany({
        where: {
          id: syncHistoryId,
          shop,
          status: "processing",
          stage: {
            in: ["MIRROR_STAGING", "INGESTING_TO_STAGING_BATCH", "VALIDATING_BATCH", "ACTIVATING_BATCH"],
          },
        },
        data: {
          status: "completed",
          stage: "MIRROR_ACTIVATED",
          recordCount: finalProductCount,
          updatedAt: completedAt,
        },
      });
      if (updatedSyncHistory.count !== 1) {
        throw new Error("SYNC_HISTORY_ACTIVATION_TRANSITION_REJECTED");
      }

      await upsertMirrorBatch(tx, {
        id: syncBatchId,
        shop,
        syncHistoryId,
        bulkOperationId: null,
        resourceType: "PRODUCT_CATALOG",
        status: "ACTIVE",
      });
      await tx.mirrorBatch.updateMany({
        where: {
          id: syncBatchId,
          shop,
          status: {
            in: [
              "BULK_OPERATION_STARTED",
              "FILE_DOWNLOADED",
              "INGESTING_TO_STAGING_BATCH",
              "VALIDATING_BATCH",
              "ACTIVATING_BATCH",
              "ACTIVE",
            ],
          },
        },
        data: {
          status: "ACTIVE",
          activatedAt: completedAt,
          actualProducts: finalProductCount,
          actualVariants: finalVariantCount,
          failureReason: null,
          failedAt: null,
        },
      });
      await transitionMirrorSyncLedgerBySyncHistoryId(tx, {
        shop,
        syncHistoryId,
        from: ["QUEUED", "STARTING_BULK_QUERY", "RUNNING", "INGESTING"],
        to: "COMPLETED",
      });
    }

    if (!syncHistoryId) {
      await tx.mirrorBatch.updateMany({
        where: {
          id: syncBatchId,
          shop,
          status: {
            in: [
              "BULK_OPERATION_STARTED",
              "FILE_DOWNLOADED",
              "INGESTING_TO_STAGING_BATCH",
              "VALIDATING_BATCH",
              "ACTIVATING_BATCH",
            ],
          },
        },
        data: {
          status: "ACTIVE",
          activatedAt: completedAt,
          actualProducts: finalProductCount,
          actualVariants: finalVariantCount,
          failureReason: null,
          failedAt: null,
        },
      });
    }

    await tx.mirrorReconcileSignal.updateMany({
      where: { shop, status: "pending" },
      data: {
        status: "resolved",
        reconciledAt: completedAt,
        updatedAt: completedAt,
      },
    });
    return true;
  }, {
      maxWait: Number(process.env.PRODUCT_SYNC_ACTIVATION_TX_MAX_WAIT_MS || 10_000),
      timeout: Number(process.env.PRODUCT_SYNC_ACTIVATION_TX_TIMEOUT_MS || 60_000),
    });

    if (activated) break;
    if (attempt === maxActivationAttempts) {
      throw new Error("STORE_ACTIVE_MIRROR_BATCH_CHANGED_DURING_ACTIVATION");
    }
  }

  if (previousBatchId && previousBatchId !== syncBatchId) {
    await addProductMirrorBatchCleanupJob({
      shop,
      mirrorBatchId: previousBatchId,
      source: "product_sync_activation",
    }).catch(async (error) => {
      await prisma.mirrorBatch.updateMany({
        where: { id: previousBatchId, shop },
        data: {
          failureReason: `POST_ACTIVATION_CLEANUP_ENQUEUE_FAILED:${error?.message || String(error)}`,
        },
      }).catch(() => {});
    });
  }
  await clearProductSyncCache(shop);
}

export async function updateInitialSyncProgress({
  shop,
  totalProductsProcessed,
}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("updateInitialSyncProgress requires shop");
  }

  const progress = Number(totalProductsProcessed);
  if (!Number.isInteger(progress) || progress < 0) {
    throw new Error("updateInitialSyncProgress requires a non-negative integer progress value");
  }

  const updated = await prisma.store.updateMany({
    where: {
      shopUrl: scopedShop,
      isUnInstalled: false,
      isProductSyncing: true,
      isProductInitialySyning: true,
      syncProgressStage: { in: ["SHOPIFY_BULK_RUNNING", "MIRROR_STAGING"] },
      productInitialSyncProgress: { lte: progress },
    },
    data: {
      productInitialSyncProgress: progress,
      syncProgressStage: "MIRROR_STAGING",
    },
  });
  if (updated.count === 1) {
    return { updated: true };
  }

  const store = await prisma.store.findUnique({
    where: { shopUrl: scopedShop },
    select: {
      isUnInstalled: true,
      isProductSyncing: true,
      isProductInitialySyning: true,
      syncProgressStage: true,
      productInitialSyncProgress: true,
    },
  });
  if (!store) {
    throw new Error("STORE_NOT_FOUND_FOR_INITIAL_SYNC_PROGRESS");
  }
  if (Number(store.productInitialSyncProgress || 0) > progress) {
    return { updated: false, reason: "stale_progress" };
  }
  return { updated: false, reason: "initial_sync_not_active" };
}
