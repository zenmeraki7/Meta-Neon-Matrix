import { db } from "../repositories/repositoryDb.js";
import { automaticProductRuleStateRepository } from "../repositories/automaticProductRuleStateRepository.js";
import { buildAutomaticRuleFingerprint } from "../utils/automaticRuleFingerprintUtils.js";
import {
  buildAutomaticRuleScopedTargets,
  buildAutomaticRuleTargetIdentity,
} from "../utils/automaticRuleTargetIdentityUtils.js";

function normalizeTriggerReference(triggerReference) {
  if (!triggerReference) return {};

  try {
    return JSON.parse(triggerReference);
  } catch (_error) {
    return { reference: String(triggerReference) };
  }
}

function buildProductInclude(actions = [], mirrorBatchId = null) {
  const needsVariants = actions.some((action) =>
    [
      "price",
      "barcode",
      "sku",
      "inventory",
      "taxable",
      "compareAtPrice",
      "option1Values",
      "option2Values",
      "option3Values",
      "inventoryPolicy",
      "cost",
      "weight",
      "weightUnit",
    ].includes(action?.field),
  );

  if (!needsVariants) return undefined;

  return {
    variants: {
      ...(mirrorBatchId
        ? {
            where: {
              mirrorBatchId,
            },
          }
        : {}),
    },
  };
}

function buildBaseWhere(where, cursorId) {
  const clauses = Array.isArray(where?.AND) ? [...where.AND] : [];
  if (cursorId) {
    clauses.push({
      id: {
        gt: cursorId,
      },
    });
  }

  return {
    ...where,
    ...(clauses.length ? { AND: clauses } : {}),
  };
}

function dedupeTargetsByIdentity(targets = []) {
  const map = new Map();
  for (const target of targets) {
    if (!target?.targetIdentity) continue;
    map.set(target.targetIdentity, target);
  }
  return Array.from(map.values());
}

function dedupeStateUpdatesByTargetIdentity(updates = []) {
  const map = new Map();
  for (const update of updates) {
    if (!update?.targetIdentity) continue;
    map.set(update.targetIdentity, update);
  }
  return Array.from(map.values());
}

function buildVariantScopedTargetFromVariantRecord(rule, variant) {
  const targetResourceType = "VARIANT";
  const product = variant.product || {};

  return {
    targetResourceType,
    targetIdentity: buildAutomaticRuleTargetIdentity({
      targetResourceType,
      productId: variant.productId,
      variantId: variant.id,
    }),
    productId: variant.productId,
    variantId: variant.id,
    productForFingerprint: {
      ...product,
      variants: [variant],
    },
    variantForFingerprint: variant,
    product,
    variant,
  };
}

export async function evaluateAutomaticRuleCandidates({ rule, run, where }) {
  const triggerMetadata = normalizeTriggerReference(run.triggerReference);
  const restrictedProductIds = Array.isArray(triggerMetadata.productIds)
    ? triggerMetadata.productIds.filter(Boolean)
    : [];
  const restrictedVariantIds = Array.isArray(triggerMetadata.variantIds)
    ? triggerMetadata.variantIds.filter(Boolean)
    : [];

  const finalWhere = {
    ...where,
    ...(restrictedProductIds.length ? { id: { in: restrictedProductIds } } : {}),
  };

  const isVariantScope = rule?.targetResourceType === "VARIANT";
  const variantBaseWhere = {
    shop: rule.shop,
    ...(run?.mirrorBatchId ? { mirrorBatchId: run.mirrorBatchId } : {}),
    product: finalWhere,
    ...(restrictedVariantIds.length ? { id: { in: restrictedVariantIds } } : {}),
  };
  const matchedCount = isVariantScope
    ? await db.variant.count({ where: variantBaseWhere })
    : await db.product.count({ where: finalWhere });
  const now = new Date();
  const candidateProductsById = new Map();
  const candidateTargets = [];
  const matchedStateUpdates = [];
  const appliedStateUpdates = [];
  const include = buildProductInclude(rule.actions, run?.mirrorBatchId || null);
  const batchSize = Math.min(rule.maxAffectedPerRun || 250, 250);
  let cursorId = null;
  let hasMore = true;

  if (isVariantScope) {
    while (hasMore) {
      const variants = await db.variant.findMany({
        where: {
          ...variantBaseWhere,
          ...(cursorId ? { id: { gt: cursorId } } : {}),
        },
        include: {
          product: true,
        },
        orderBy: { id: "asc" },
        take: batchSize,
      });

      if (!variants.length) {
        break;
      }

      cursorId = variants[variants.length - 1].id;
      hasMore = variants.length === batchSize;

      const scopedTargets = variants.map((variant) =>
        buildVariantScopedTargetFromVariantRecord(rule, variant),
      );

      const states = await automaticProductRuleStateRepository.findByRuleAndTargetIdentities(
        rule.id,
        rule.shop,
        scopedTargets.map((target) => target.targetIdentity),
      );

      const stateByTargetIdentity = states.reduce((accumulator, state) => {
        accumulator[state.targetIdentity] = state;
        return accumulator;
      }, {});

      for (const target of scopedTargets) {
        const currentState = stateByTargetIdentity[target.targetIdentity] || null;
        const fingerprint = buildAutomaticRuleFingerprint({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          product: target.productForFingerprint,
          variant: target.variantForFingerprint || target.variant || null,
          actions: rule.actions,
          applyMode: rule.applyMode,
        });

        matchedStateUpdates.push({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          productId: target.productId,
          variantId: target.variantId,
          lastMatchedAt: now,
        });

        if (currentState?.suppressedUntil && new Date(currentState.suppressedUntil) > now) {
          continue;
        }

        if (currentState?.lastFingerprint && currentState.lastFingerprint === fingerprint) {
          continue;
        }

        if (rule.cooldownMinutes && currentState?.lastAppliedAt) {
          const cooldownUntil = new Date(currentState.lastAppliedAt);
          cooldownUntil.setMinutes(cooldownUntil.getMinutes() + rule.cooldownMinutes);
          if (cooldownUntil > now) {
            continue;
          }
        }

        appliedStateUpdates.push({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          productId: target.productId,
          variantId: target.variantId || null,
          lastMatchedAt: now,
          lastFingerprint: fingerprint,
          lastAppliedAt: now,
          suppressedUntil: rule.cooldownMinutes
            ? new Date(now.getTime() + rule.cooldownMinutes * 60_000)
            : null,
        });
        candidateTargets.push({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          productId: target.productId,
          variantId: target.variantId || null,
          product: target.product || null,
          variant: target.variant || target.variantForFingerprint || null,
          fingerprint,
        });

        if (target.product?.id) {
          candidateProductsById.set(target.product.id, target.product);
        }

        if (rule.maxAffectedPerRun && candidateTargets.length >= rule.maxAffectedPerRun) {
          hasMore = false;
          break;
        }
      }

      if (restrictedVariantIds.length || restrictedProductIds.length) {
        hasMore = false;
      }
    }

    return {
      matchedCount,
      candidateProducts: Array.from(candidateProductsById.values()),
      candidateTargets: dedupeTargetsByIdentity(candidateTargets),
      matchedStateUpdates: dedupeStateUpdatesByTargetIdentity(matchedStateUpdates),
      appliedStateUpdates: dedupeStateUpdatesByTargetIdentity(appliedStateUpdates),
    };
  }

  while (hasMore) {
    const products = await db.product.findMany({
      where: buildBaseWhere(finalWhere, cursorId),
      ...(include ? { include } : {}),
      orderBy: { id: "asc" },
      take: batchSize,
    });

    if (!products.length) {
      break;
    }

    cursorId = products[products.length - 1].id;
    hasMore = products.length === batchSize;

    const scopedTargets = products.flatMap((product) =>
      buildAutomaticRuleScopedTargets(rule, product),
    );

    const states = await automaticProductRuleStateRepository.findByRuleAndTargetIdentities(
      rule.id,
      rule.shop,
      scopedTargets.map((target) => target.targetIdentity),
    );

    const stateByTargetIdentity = states.reduce((accumulator, state) => {
      accumulator[state.targetIdentity] = state;
      return accumulator;
    }, {});

    for (const product of products) {
      const targets = buildAutomaticRuleScopedTargets(rule, product);

      for (const target of targets) {
        if (
          restrictedVariantIds.length &&
          target.variantId &&
          !restrictedVariantIds.includes(target.variantId)
        ) {
          continue;
        }

        const currentState = stateByTargetIdentity[target.targetIdentity] || null;
        const fingerprint = buildAutomaticRuleFingerprint({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          product: target.productForFingerprint,
          variant: target.variantForFingerprint || target.variant || null,
          actions: rule.actions,
          applyMode: rule.applyMode,
        });

        matchedStateUpdates.push({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          productId: target.productId,
          variantId: target.variantId,
          lastMatchedAt: now,
        });

        if (currentState?.suppressedUntil && new Date(currentState.suppressedUntil) > now) {
          continue;
        }

        if (currentState?.lastFingerprint && currentState.lastFingerprint === fingerprint) {
          continue;
        }

        if (rule.cooldownMinutes && currentState?.lastAppliedAt) {
          const cooldownUntil = new Date(currentState.lastAppliedAt);
          cooldownUntil.setMinutes(cooldownUntil.getMinutes() + rule.cooldownMinutes);
          if (cooldownUntil > now) {
            continue;
          }
        }

        appliedStateUpdates.push({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          productId: target.productId,
          variantId: target.variantId || null,
          lastMatchedAt: now,
          lastFingerprint: fingerprint,
          lastAppliedAt: now,
          suppressedUntil: rule.cooldownMinutes
            ? new Date(now.getTime() + rule.cooldownMinutes * 60_000)
            : null,
        });
        candidateTargets.push({
          targetResourceType: target.targetResourceType,
          targetIdentity: target.targetIdentity,
          productId: target.productId,
          variantId: target.variantId || null,
          product,
          variant: target.variant || target.variantForFingerprint || null,
          fingerprint,
        });
        candidateProductsById.set(product.id, product);

        if (rule.maxAffectedPerRun && candidateTargets.length >= rule.maxAffectedPerRun) {
          hasMore = false;
          break;
        }
      }

      if (rule.maxAffectedPerRun && candidateTargets.length >= rule.maxAffectedPerRun) {
        hasMore = false;
        break;
      }
    }

    if (restrictedProductIds.length) {
      hasMore = false;
    }
  }

  return {
    matchedCount,
    candidateProducts: Array.from(candidateProductsById.values()),
    candidateTargets: dedupeTargetsByIdentity(candidateTargets),
    matchedStateUpdates: dedupeStateUpdatesByTargetIdentity(matchedStateUpdates),
    appliedStateUpdates: dedupeStateUpdatesByTargetIdentity(appliedStateUpdates),
  };
}

export async function persistMatchedStateUpdates(rule, matchedStateUpdates = [], run = null) {
  for (const update of matchedStateUpdates) {
    await automaticProductRuleStateRepository.upsertState({
      automaticProductRuleId: rule.id,
      shop: rule.shop,
      targetResourceType: update.targetResourceType || "PRODUCT",
      targetIdentity:
        update.targetIdentity ||
        buildAutomaticRuleTargetIdentity({
          targetResourceType: update.targetResourceType || "PRODUCT",
          productId: update.productId,
          variantId: update.variantId || null,
        }),
      productId: update.productId,
      variantId: update.variantId || null,
      data: {
        lastMatchedAt: update.lastMatchedAt,
        lastMirrorBatchId: run?.mirrorBatchId || null,
        lastTriggerReference: run?.triggerReference || null,
        lastAutomaticRuleRunId: run?.id || null,
      },
    });
  }
}

export async function persistAppliedStateUpdates(rule, appliedStateUpdates = [], run = null) {
  for (const update of appliedStateUpdates) {
    await automaticProductRuleStateRepository.upsertState({
      automaticProductRuleId: rule.id,
      shop: rule.shop,
      targetResourceType: update.targetResourceType || "PRODUCT",
      targetIdentity:
        update.targetIdentity ||
        buildAutomaticRuleTargetIdentity({
          targetResourceType: update.targetResourceType || "PRODUCT",
          productId: update.productId,
          variantId: update.variantId || null,
        }),
      productId: update.productId,
      variantId: update.variantId || null,
      data: {
        lastMatchedAt: update.lastMatchedAt,
        lastAppliedAt: update.lastAppliedAt,
        lastFingerprint: update.lastFingerprint,
        suppressedUntil: update.suppressedUntil,
        lastMirrorBatchId: run?.mirrorBatchId || null,
        lastTriggerReference: run?.triggerReference || null,
        lastAutomaticRuleRunId: run?.id || null,
      },
    });
  }
}

