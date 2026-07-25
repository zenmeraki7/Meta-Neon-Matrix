import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import { recurringRuleRunJobId } from "../../utils/jobQueueUtils.js";
import { requireShopScope } from "../../utils/shopScope.js";

export const RECURRING_EDIT_EXECUTION_QUEUE =
  process.env.RECURRING_EDIT_EXECUTION_QUEUE || "recurring-edit-execution";

const recurringEditExecutionQueue = new Queue(RECURRING_EDIT_EXECUTION_QUEUE, {
  connection,
});

export async function enqueueRecurringEditExecution({
  recurringEditRunId,
  shop,
  recurringEditId = null,
  scheduledFor = null,
}) {
  const scopedShop = requireShopScope(shop);
  const ruleId = recurringEditId || recurringEditRunId;
  const scheduledForKey = scheduledFor
    ? new Date(scheduledFor).toISOString()
    : "unspecified";
  return recurringEditExecutionQueue.add(
    "recurring-edit-execution",
    { recurringEditRunId, shop: scopedShop },
    {
      jobId: recurringRuleRunJobId({
        shop: scopedShop,
        ruleId,
        scheduledFor: scheduledForKey,
      }),
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
