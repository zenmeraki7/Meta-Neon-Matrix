import { publicError } from "./automaticProductRuleErrors.js";
import {
  ACTIVE_RUN_STATUSES,
  RULE_STATUS,
  OPERATION_SOURCE,
} from "./automaticProductRuleConstants.js";

export function actorRef(actor) {
  return actor?.userId || actor?.sessionId || actor?.userEmail || actor?.shop || "system";
}

export function assertShop(shop) {
  if (typeof shop !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop.trim())) {
    throw publicError("INVALID_SHOP_CONTEXT", 400, "Invalid shop context.");
  }

  return shop.trim().toLowerCase();
}

export function assertActor(actor, shop) {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw publicError("ACTOR_REQUIRED", 400, "Actor context is required.");
  }

  if (actor.shop !== shop) {
    throw publicError("ACTOR_SHOP_MISMATCH", 400, "Actor context does not match shop context.");
  }

  if (!actor.actorType) {
    throw publicError("ACTOR_TYPE_REQUIRED", 400, "Actor type is required.");
  }

  return actor;
}

export function assertEntitlementAllowed(entitlement) {
  if (!entitlement || typeof entitlement !== "object") {
    throw publicError("ENTITLEMENT_CONTEXT_REQUIRED", 403, "Entitlement context is required.");
  }

  if (entitlement.allowed !== true) {
    throw publicError("ENTITLEMENT_DENIED", 403, "Automatic product rules are not available for the current shop.");
  }

  return entitlement;
}

export function assertRuleId(ruleId) {
  if (typeof ruleId !== "string" || ruleId.trim().length < 8 || ruleId.trim().length > 128) {
    throw publicError("INVALID_AUTOMATIC_RULE_ID", 400, "Invalid automatic product rule id.");
  }

  return ruleId.trim();
}

export function assertIdempotencyKey(idempotencyKey) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 16 || idempotencyKey.trim().length > 128) {
    throw publicError("IDEMPOTENCY_KEY_REQUIRED", 400, "Idempotency key is required.");
  }

  return idempotencyKey.trim();
}

export function assertExpectedRuleRevision(expectedRuleRevision) {
  if (!Number.isInteger(expectedRuleRevision) || expectedRuleRevision < 1) {
    throw publicError("EXPECTED_RULE_REVISION_REQUIRED", 400, "Expected rule revision is required.");
  }

  return expectedRuleRevision;
}

export function assertRuleRevision(rule, expectedRuleRevision) {
  if (rule.revision !== expectedRuleRevision) {
    throw publicError("STALE_RULE_REVISION", 409, "Automatic rule has changed. Refresh and try again.", {
      currentRevision: rule.revision,
      expectedRuleRevision,
    });
  }
}

export function assertRuleRunnable(rule) {
  if (![RULE_STATUS.ACTIVE, RULE_STATUS.PAUSED].includes(rule.status)) {
    throw publicError("RULE_NOT_RUNNABLE", 409, "Automatic rule cannot be run in its current state.");
  }
}

export function assertValidStateTransition({ from, to }) {
  const allowed = {
    [RULE_STATUS.DRAFT]: [RULE_STATUS.ACTIVE, RULE_STATUS.PAUSED, RULE_STATUS.DELETED],
    [RULE_STATUS.ACTIVE]: [RULE_STATUS.PAUSED, RULE_STATUS.DELETED],
    [RULE_STATUS.PAUSED]: [RULE_STATUS.ACTIVE, RULE_STATUS.DELETED],
    [RULE_STATUS.DELETED]: [],
  };

  if (!allowed[from]?.includes(to)) {
    throw publicError("INVALID_RULE_STATE_TRANSITION", 409, `Invalid automatic rule state transition from ${from} to ${to}.`);
  }
}

export async function findRuleByShopAndIdOrThrow({ tx, shop, automaticProductRuleId }) {
  const rule = await tx.automaticProductRule.findFirst({
    where: {
      shop,
      id: automaticProductRuleId,
      deletedAt: null,
    },
  });

  if (!rule) {
    throw publicError("RULE_NOT_FOUND", 404, "Automatic product rule not found.");
  }

  return rule;
}

export async function assertAutomaticRuleQuota({ tx, shop, entitlement }) {
  const maxAutomaticRules = entitlement?.limits?.maxAutomaticRules;

  if (!Number.isInteger(maxAutomaticRules)) {
    return;
  }

  const count = await tx.automaticProductRule.count({
    where: {
      shop,
      deletedAt: null,
      status: {
        in: [RULE_STATUS.DRAFT, RULE_STATUS.ACTIVE, RULE_STATUS.PAUSED],
      },
    },
  });

  if (count >= maxAutomaticRules) {
    throw publicError("AUTOMATIC_RULE_LIMIT_REACHED", 403, "Automatic rule limit reached for the current plan.");
  }
}

export async function assertResumeQuota({ tx, shop, entitlement }) {
  const maxActiveRules = entitlement?.limits?.maxActiveAutomaticRules;

  if (!Number.isInteger(maxActiveRules)) {
    return;
  }

  const count = await tx.automaticProductRule.count({
    where: {
      shop,
      deletedAt: null,
      status: RULE_STATUS.ACTIVE,
    },
  });

  if (count >= maxActiveRules) {
    throw publicError("ACTIVE_AUTOMATIC_RULE_LIMIT_REACHED", 403, "Active automatic rule limit reached for the current plan.");
  }
}

export async function assertManualRunQuota({ tx, shop, ruleId, entitlement }) {
  const maxManualRunsPerRulePerHour = entitlement?.limits?.maxManualRunsPerRulePerHour ?? 3;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const count = await tx.automaticProductRuleRun.count({
    where: {
      shop,
      automaticProductRuleId: ruleId,
      source: OPERATION_SOURCE.AUTOMATIC_RULE_RUN_NOW,
      createdAt: {
        gte: oneHourAgo,
      },
    },
  });

  if (count >= maxManualRunsPerRulePerHour) {
    throw publicError("AUTOMATIC_RULE_RUN_LIMIT_REACHED", 429, "This automatic rule has reached the manual run limit.");
  }
}

export async function assertMirrorSafeForTargeting({ tx, shop }) {
  const store = await tx.store.findUnique({
    where: { shop },
    select: {
      shop: true,
      activeMirrorBatchId: true,
      mirrorHealthState: true,
      mirrorUnsafeSince: true,
      isProductInitialySyning: true,
    },
  });

  if (!store?.activeMirrorBatchId) {
    throw publicError("MIRROR_NOT_READY", 409, "Product catalog mirror is not ready for automatic rules.");
  }

  if (store.mirrorHealthState === "UNSAFE" || store.isProductInitialySyning === true) {
    throw publicError("MIRROR_NOT_SAFE_FOR_TARGETING", 409, "Product catalog mirror is not safe for targeting.");
  }

  return store;
}

export async function assertNoActiveRun({ tx, shop, ruleId }) {
  const activeRun = await tx.automaticProductRuleRun.findFirst({
    where: {
      shop,
      automaticProductRuleId: ruleId,
      status: {
        in: [...ACTIVE_RUN_STATUSES],
      },
    },
    select: {
      id: true,
      status: true,
      operationId: true,
    },
  });

  if (activeRun) {
    throw publicError("AUTOMATIC_RULE_RUN_ALREADY_ACTIVE", 409, "This automatic rule already has an active run.", activeRun);
  }
}

export async function assertNoActiveRunForConfigMutation({ tx, shop, ruleId }) {
  const activeRun = await tx.automaticProductRuleRun.findFirst({
    where: {
      shop,
      automaticProductRuleId: ruleId,
      status: {
        in: [...ACTIVE_RUN_STATUSES],
      },
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (activeRun) {
    throw publicError("RULE_HAS_ACTIVE_RUN", 409, "Automatic rule cannot be changed while it has an active run.", activeRun);
  }
}
