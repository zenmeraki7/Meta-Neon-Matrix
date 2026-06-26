import { cleanupOrphanedProductMirrorRowsForAllShops } from "../../services/mirrorBatchCleanupService.js";
import logger from "../../utils/loggerUtils.js";

// Cleanup is not time-critical like the export/edit schedulers — running
// every 30 minutes is more than enough to keep orphaned rows from piling up,
// without adding extra load to the database on every tick.
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function runCleanupTick() {
  try {
    const result = await cleanupOrphanedProductMirrorRowsForAllShops();

    if (result.shopsCleaned > 0) {
      logger.info("Orphaned mirror batch cleanup tick", {
        shopsChecked: result.shopsChecked,
        shopsCleaned: result.shopsCleaned,
        totalProductsDeleted: result.totalProductsDeleted,
        totalVariantsDeleted: result.totalVariantsDeleted,
      });
    }
  } catch (error) {
    logger.error("Orphaned mirror batch cleanup tick failed", {
      error: error.message,
      stack: error.stack,
    });
  }
}

if (!globalThis.__mirrorBatchCleanupSchedulerStarted) {
  globalThis.__mirrorBatchCleanupSchedulerStarted = true;
  setTimeout(runCleanupTick, 15_000);
  setInterval(runCleanupTick, CLEANUP_INTERVAL_MS);
}