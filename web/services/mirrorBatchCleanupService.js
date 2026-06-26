import { prisma } from "../config/database.js";
import logger from "../utils/loggerUtils.js";

/**
 * Deletes leftover Product/Variant rows from old, abandoned sync batches.
 *
 * Every successful sync writes rows tagged with a fresh `mirrorBatchId`,
 * then deletes the single previous batch once the new one is activated.
 * If a sync ever fails or is interrupted partway through (DB hiccup,
 * server restart, etc.), its rows never get cleaned up — they just sit
 * there forever as orphans, since nothing ever points back to them again.
 *
 * This function is the safety net: for a given shop, it deletes every
 * Product/Variant row whose mirrorBatchId is NOT the shop's current
 * activeMirrorBatchId. That includes orphans from any number of past
 * failed attempts, not just the single most recent one.
 */
export async function cleanupOrphanedProductMirrorRows(shop) {
  const store = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: {
      activeMirrorBatchId: true,
      isProductSyncing: true,
    },
  });

  if (!store) {
    return { shop, skipped: true, reason: "store_not_found" };
  }

  // Never clean up while a sync is actively running for this shop —
  // its in-progress batch hasn't been activated yet, so it would
  // look "orphaned" to this check even though it's legitimately in use.
  if (store.isProductSyncing) {
    return { shop, skipped: true, reason: "sync_in_progress" };
  }

  if (!store.activeMirrorBatchId) {
    return { shop, skipped: true, reason: "no_active_batch_yet" };
  }

  const { activeMirrorBatchId } = store;

  const deletedVariants = await prisma.variant.deleteMany({
    where: {
      shop,
      mirrorBatchId: { not: activeMirrorBatchId },
    },
  });

  const deletedProducts = await prisma.product.deleteMany({
    where: {
      shop,
      mirrorBatchId: { not: activeMirrorBatchId },
    },
  });

  if (deletedProducts.count > 0 || deletedVariants.count > 0) {
    logger.info("Cleaned up orphaned mirror batch rows", {
      shop,
      activeMirrorBatchId,
      deletedProducts: deletedProducts.count,
      deletedVariants: deletedVariants.count,
    });
  }

  return {
    shop,
    skipped: false,
    activeMirrorBatchId,
    deletedProducts: deletedProducts.count,
    deletedVariants: deletedVariants.count,
  };
}

/**
 * Runs the orphan cleanup across every installed shop, in small batches
 * so we never hold one giant query/result set in memory.
 */
export async function cleanupOrphanedProductMirrorRowsForAllShops({
  batchSize = 20,
} = {}) {
  let lastId = null;
  let shopsChecked = 0;
  let shopsCleaned = 0;
  let totalProductsDeleted = 0;
  let totalVariantsDeleted = 0;

  while (true) {
    const stores = await prisma.store.findMany({
      where: { isUnInstalled: false },
      select: { id: true, shopUrl: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(lastId && { cursor: { id: lastId }, skip: 1 }),
    });

    if (stores.length === 0) break;

    for (const store of stores) {
      shopsChecked += 1;

      try {
        const result = await cleanupOrphanedProductMirrorRows(store.shopUrl);

        if (!result.skipped && (result.deletedProducts > 0 || result.deletedVariants > 0)) {
          shopsCleaned += 1;
          totalProductsDeleted += result.deletedProducts;
          totalVariantsDeleted += result.deletedVariants;
        }
      } catch (error) {
        logger.error("Orphaned mirror batch cleanup failed for shop", {
          shop: store.shopUrl,
          error: error.message,
        });
      }
    }

    lastId = stores[stores.length - 1].id;
  }

  return {
    shopsChecked,
    shopsCleaned,
    totalProductsDeleted,
    totalVariantsDeleted,
  };
}