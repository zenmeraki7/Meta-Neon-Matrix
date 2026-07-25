import crypto from "crypto";
import { buildAutomaticRuleTargetIdentity } from "../utils/automaticRuleTargetIdentityUtils.js";

function buildAutomaticRuleTargetFingerprint({
  ruleId,
  targetIdentity,
  ruleFingerprint,
  triggerReference,
}) {
  const payload = JSON.stringify({
    ruleId,
    targetIdentity,
    ruleFingerprint: ruleFingerprint || null,
    triggerReference: triggerReference || null,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function reserveAutomaticRuleApplications({
  createApplication,
  rule,
  run,
  candidateTargets,
  candidateProducts,
  appliedStateUpdates,
}) {
  const updates = Array.isArray(appliedStateUpdates) ? appliedStateUpdates : [];
  const targetList = Array.isArray(candidateTargets) ? candidateTargets : [];
  const targetByIdentity = new Map(
    targetList
      .filter((target) => target?.targetIdentity)
      .map((target) => [target.targetIdentity, target]),
  );
  const productById = new Map(
    [
      ...(Array.isArray(candidateProducts) ? candidateProducts : []),
      ...targetList
        .map((target) => target?.product)
        .filter(Boolean),
    ].map((product) => [product.id, product]),
  );

  const acceptedTargets = [];
  const acceptedProducts = [];
  const skippedProducts = [];
  const acceptedProductIds = new Set();

  for (const update of updates) {
    const targetResourceType = update.targetResourceType || "PRODUCT";
    const targetIdentity = update.targetIdentity || buildAutomaticRuleTargetIdentity({
      targetResourceType,
      productId: update.productId,
      variantId: update.variantId || null,
    });
    const targetRowHash = buildAutomaticRuleTargetFingerprint({
      ruleId: rule.id,
      targetIdentity,
      ruleFingerprint: update.lastFingerprint || null,
      triggerReference: run.triggerReference,
    });

    try {
      await createApplication({
        shop: rule.shop,
        ruleId: rule.id,
        automaticRuleRunId: run.id,
        targetResourceType,
        productId: update.productId || null,
        variantId: update.variantId || null,
        targetIdentity,
        triggerReference: run.triggerReference || null,
        targetRowHash,
        status: "RESERVED",
      });
      const candidateTarget = targetByIdentity.get(targetIdentity);
      if (candidateTarget) acceptedTargets.push(candidateTarget);
      if (update.productId) acceptedProductIds.add(update.productId);
    } catch (error) {
      if (error?.code === "P2002") {
        skippedProducts.push(targetIdentity);
        continue;
      }
      throw error;
    }
  }

  for (const productId of acceptedProductIds) {
    const product = productById.get(productId);
    if (product) acceptedProducts.push(product);
  }

  return {
    acceptedTargets,
    acceptedProducts,
    skippedProducts,
  };
}
