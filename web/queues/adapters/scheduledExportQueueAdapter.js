import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import { scheduledExportRunJobId } from "../../utils/jobQueueUtils.js";
import { requireShopScope } from "../../utils/shopScope.js";

export const SCHEDULED_EXPORT_EXECUTION_QUEUE =
  process.env.SCHEDULED_EXPORT_EXECUTION_QUEUE || "scheduled-export-execution";

const scheduledExportExecutionQueue = new Queue(SCHEDULED_EXPORT_EXECUTION_QUEUE, {
  connection,
});

export async function enqueueScheduledExportExecution({
  runId,
  shop,
  scheduledExportId = null,
  scheduledFor = null,
  delay = 0,
  jobId = null,
}) {
  const scopedShop = requireShopScope(shop);
  const resolvedJobId =
    jobId
    || scheduledExportRunJobId({
      shop: scopedShop,
      scheduledExportId: scheduledExportId || runId,
      scheduledFor: scheduledFor || "unspecified",
    });
  return scheduledExportExecutionQueue.add(
    "scheduled-export-execution",
    { runId, shop: scopedShop },
    {
      jobId: resolvedJobId,
      delay,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 20000 },
      attempts: 6,
      backoff: {
        type: "exponential",
        delay: 30_000,
      },
    },
  );
}
