import { db } from "../repositories/repositoryDb.js";
import logger from "../utils/loggerUtils.js";
import {
  bulkEditChangeRecordFailureRate,
  bulkEditStuckJobs,
} from "../utils/metricsUtils.js";

export async function recordOperationalHealthForShop(shop) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("shop is required for operational health monitoring");
  }

  const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000);
  const errorWindowStart = new Date(Date.now() - 10 * 60 * 1000);
  const [stuck, totalChangeRecords, failedChangeRecords] = await Promise.all([
    db.editHistory.findMany({
      where: {
        shop: scopedShop,
        status: { in: ["processing", "pending"] },
        updatedAt: { lt: stuckCutoff },
      },
      select: { id: true, status: true, type: true, updatedAt: true },
      take: 100,
    }),
    db.changeRecord.count({
      where: { shop: scopedShop, createdAt: { gte: errorWindowStart } },
    }),
    db.changeRecord.count({
      where: {
        shop: scopedShop,
        createdAt: { gte: errorWindowStart },
        status: { in: ["FAILED", "ERROR"] },
      },
    }),
  ]);

  const failureRate = totalChangeRecords > 0
    ? failedChangeRecords / totalChangeRecords
    : 0;
  bulkEditStuckJobs.set({ shop: scopedShop }, stuck.length);
  bulkEditChangeRecordFailureRate.set({ shop: scopedShop }, failureRate);

  if (stuck.length > 0) {
    logger.error("STUCK_JOBS_DETECTED", {
      shop: scopedShop,
      count: stuck.length,
      jobs: stuck,
    });
  }
  if (failureRate > 0.05) {
    logger.error("HIGH_CHANGE_RECORD_ERROR_RATE", {
      shop: scopedShop,
      failedCount: failedChangeRecords,
      totalCount: totalChangeRecords,
      errorRate: failureRate,
    });
  }

  return {
    stuckCount: stuck.length,
    failedChangeRecords,
    totalChangeRecords,
    failureRate,
  };
}
