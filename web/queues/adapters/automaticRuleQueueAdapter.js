import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import { buildAutomaticRuleRunJobId, joinSafeJobId } from "../../utils/jobQueueUtils.js";
import { requireShopScope } from "../../utils/shopScope.js";

export const AUTOMATIC_PRODUCT_RULE_EXECUTION_QUEUE =
  process.env.AUTOMATIC_PRODUCT_RULE_EXECUTION_QUEUE || "automatic-product-rule-execution";
export const AUTOMATIC_PRODUCT_RULE_SIGNAL_QUEUE =
  process.env.AUTOMATIC_PRODUCT_RULE_SIGNAL_QUEUE || "automatic-product-rule-signal";

const executionQueue = new Queue(AUTOMATIC_PRODUCT_RULE_EXECUTION_QUEUE, { connection });
const signalQueue = new Queue(AUTOMATIC_PRODUCT_RULE_SIGNAL_QUEUE, { connection });

export async function enqueueAutomaticRuleExecution(automaticRuleRunId, shop, opts = {}) {
  const scopedShop = requireShopScope(shop);
  let ruleId = opts.ruleId || null;
  let executionDedupeKey = opts.executionDedupeKey || null;

  if (!ruleId || !executionDedupeKey) {
    const { automaticProductRuleRunRepository } = await import("../../repositories/automaticProductRuleRunRepository.js");
    const run = await automaticProductRuleRunRepository.findByIdForShop(automaticRuleRunId, scopedShop);
    ruleId = ruleId || run?.automaticProductRuleId || automaticRuleRunId;
    executionDedupeKey = executionDedupeKey || run?.executionDedupeKey || automaticRuleRunId;
  }

  return executionQueue.add(
    "automatic-product-rule-execution",
    { automaticRuleRunId, shop: scopedShop },
    {
      jobId: buildAutomaticRuleRunJobId({
        shop: scopedShop,
        ruleId,
        executionDedupeKey,
      }),
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 20000 },
      attempts: 8,
      backoff: {
        type: "exponential",
        delay: 30_000,
      },
      ...opts,
    },
  );
}

export async function enqueueAutomaticRuleSignal({
  shop,
  productIds = [],
  triggerReference,
  triggerSource = "WEBHOOK",
}) {
  const scopedShop = requireShopScope(shop);
  const signalFingerprint = (await import("crypto"))
    .createHash("sha256")
    .update(
      JSON.stringify({
        shop: scopedShop,
        triggerSource,
        triggerReference: triggerReference || null,
        productIds: [...new Set(productIds.filter(Boolean))].sort(),
      }),
    )
    .digest("hex");

  return signalQueue.add(
    "automatic-product-rule-signal",
    { shop: scopedShop, productIds, triggerReference, triggerSource },
    {
      jobId: joinSafeJobId("automatic-rule-signal", scopedShop, signalFingerprint),
      removeOnComplete: 200,
      removeOnFail: 200,
      attempts: 8,
      backoff: {
        type: "exponential",
        delay: 10_000,
      },
    },
  );
}
