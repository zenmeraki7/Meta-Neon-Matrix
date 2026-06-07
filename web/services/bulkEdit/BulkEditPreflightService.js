import { getPlanMaxBulkEditTargets } from "./bulkEditPlanUtils.js";

export const BROAD_TARGET_THRESHOLD = 1_000;
export const CRITICAL_TARGET_THRESHOLD = 10_000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export class PreflightError extends Error {
  constructor(code, details = {}) {
    super(details.message || code);
    this.name = "PreflightError";
    this.code = code;
    this.details = details;
    this.nonRetryable = true;
  }
}

function normalized(value) {
  return String(value || "").trim().toUpperCase();
}

function isSetValueOperation(editOption) {
  return ["SET VALUE", "SET TO FIXED VALUE", "SETVALUE"].includes(
    normalized(editOption).replace(/_/g, " "),
  );
}

function requiredCriticalConfirmation(targetCount) {
  return `EDIT ${Number(targetCount || 0).toLocaleString("en-US")} PRODUCTS`;
}

export function preflightMirrorState(store, nowMs = Date.now()) {
  if (!store) {
    throw new PreflightError("STORE_NOT_INITIALIZED");
  }
  const health = normalized(store.mirrorHealthState);
  if (
    !store.activeMirrorBatchId
    || store.repairRequired
    || ["UNSAFE", "REPAIR_REQUIRED"].includes(health)
  ) {
    throw new PreflightError("MIRROR_UNSAFE", {
      message: "Product data is being refreshed. Bulk edits are temporarily unavailable.",
      lastSyncAt: store.lastFullSyncAt || null,
    });
  }

  const lastSyncAt = store.lastIncrementalSyncAt || store.lastFullSyncAt;
  const parsedLastSyncMs = lastSyncAt ? new Date(lastSyncAt).getTime() : Number.NaN;
  const staleMs = Number.isFinite(parsedLastSyncMs)
    ? Math.max(0, nowMs - parsedLastSyncMs)
    : Number.POSITIVE_INFINITY;
  return staleMs > SIX_HOURS_MS
    ? {
      stale: true,
      staleMs,
      warning: "Product data may be more than 6 hours old. Recent manual changes may not be reflected.",
    }
    : { stale: false, staleMs };
}

export function preflightPreviewContract({
  previewRecord,
  activeMirrorBatchId,
  command = {},
  now = new Date(),
}) {
  if (!previewRecord) {
    throw new PreflightError("PREVIEW_NOT_FOUND");
  }
  if (previewRecord.expiresAt && new Date(previewRecord.expiresAt) < now) {
    throw new PreflightError("PREVIEW_EXPIRED", {
      expiredAt: previewRecord.expiresAt,
      message: "This preview has expired. Please generate a new preview.",
    });
  }
  const previewBatchId = String(previewRecord?.value?.mirrorBatchId || "").trim();
  if (!previewBatchId) {
    throw new PreflightError("PREVIEW_FINGERPRINT_INCOMPLETE");
  }
  if (previewBatchId !== String(activeMirrorBatchId || "").trim()) {
    throw new PreflightError("PREVIEW_MIRROR_BATCH_STALE", {
      previewBatchId,
      currentBatchId: activeMirrorBatchId || null,
      message: "Product data has been refreshed since this preview was generated. Please preview again.",
    });
  }
  const previewFilterHash = String(previewRecord?.value?.filterHash || "").trim();
  if (
    command.previewFilterHash
    && String(command.previewFilterHash).trim() !== previewFilterHash
  ) {
    throw new PreflightError("PREVIEW_TARGETING_FINGERPRINT_MISMATCH");
  }
  if (
    command.previewMirrorBatchId
    && String(command.previewMirrorBatchId).trim() !== previewBatchId
  ) {
    throw new PreflightError("PREVIEW_MIRROR_BATCH_MISMATCH");
  }
}

export function preflightScope({
  targetCount,
  confirmBroadTarget = false,
  criticalConfirmationText = "",
  previewRequiresConfirmation = false,
}) {
  const count = Number(targetCount || 0);
  if (!Number.isFinite(count) || count < 0) {
    throw new PreflightError("TARGET_COUNT_INVALID", { targetCount });
  }
  if ((previewRequiresConfirmation || count > BROAD_TARGET_THRESHOLD) && !confirmBroadTarget) {
    throw new PreflightError("BROAD_TARGET_REQUIRES_CONFIRMATION", {
      targetCount: count,
      threshold: BROAD_TARGET_THRESHOLD,
      requiresField: "confirmBroadTarget",
    });
  }
  if (count > CRITICAL_TARGET_THRESHOLD) {
    const required = requiredCriticalConfirmation(count);
    if (String(criticalConfirmationText || "").trim() !== required) {
      throw new PreflightError("CRITICAL_TARGET_REQUIRES_TEXT_CONFIRMATION", {
        targetCount: count,
        requiredCriticalConfirmation: required,
      });
    }
  }
  return { targetCount: count, broad: count > BROAD_TARGET_THRESHOLD };
}

export function preflightValues({
  rules = [],
  targetCount = 0,
  confirmBroadTarget = false,
}) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    const field = String(rule?.field || "");
    const editOption = rule?.editOption ?? rule?.operator;
    const value = rule?.value;
    const numericValue = Number(value);

    if (["price", "compareAtPrice"].includes(field) && Number.isFinite(numericValue)) {
      if (numericValue < 0) {
        throw new PreflightError("NEGATIVE_PRICE_NOT_ALLOWED", { field, value });
      }
      if (isSetValueOperation(editOption) && numericValue === 0 && !confirmBroadTarget) {
        throw new PreflightError("ZERO_PRICE_REQUIRES_CONFIRMATION", {
          field,
          value,
          message: "Setting price to 0.00 can make products free. Confirm this is intended.",
        });
      }
    }
    if (
      ["inventory", "inventoryQuantity"].includes(field)
      && Number.isFinite(numericValue)
      && numericValue < 0
    ) {
      throw new PreflightError("NEGATIVE_INVENTORY_NOT_ALLOWED", { field, value });
    }
    if (
      field === "status"
      && normalized(value) === "ARCHIVED"
      && Number(targetCount || 0) > BROAD_TARGET_THRESHOLD
      && !confirmBroadTarget
    ) {
      throw new PreflightError("MASS_ARCHIVE_REQUIRES_CONFIRMATION", {
        targetCount: Number(targetCount || 0),
      });
    }
  }
}

export function preflightEntitlement({
  targetCount,
  subscription = {},
  scheduledAt = null,
}) {
  const maxProducts = getPlanMaxBulkEditTargets(subscription);
  if (Number(targetCount || 0) > maxProducts) {
    throw new PreflightError("PLAN_LIMIT_EXCEEDED", {
      targetCount: Number(targetCount || 0),
      maxProducts,
      planKey: subscription?.planKey || null,
      upgradeRequired: true,
    });
  }
  const scheduledEdits =
    subscription?.scheduledEdits
    ?? subscription?.features?.scheduledEdits
    ?? subscription?.entitlements?.scheduledEdits;
  if (scheduledAt && scheduledEdits === false) {
    throw new PreflightError("SCHEDULED_EDITS_NOT_AVAILABLE", {
      planKey: subscription?.planKey || null,
      upgradeRequired: true,
    });
  }
  return { maxProducts };
}

export function runBulkEditPreflight({
  command,
  previewRecord = null,
  store,
  rules,
  targetCount,
  subscription = {},
  requirePreview = true,
  now = new Date(),
}) {
  const warnings = [];
  const mirror = preflightMirrorState(store, now.getTime());
  if (mirror.stale) {
    warnings.push({ code: "MIRROR_STALE", message: mirror.warning, staleMs: mirror.staleMs });
  }
  if (requirePreview) {
    if (!command?.previewId && !command?.previewContractId) {
      throw new PreflightError("PREVIEW_REQUIRED");
    }
    preflightPreviewContract({
      previewRecord,
      activeMirrorBatchId: store.activeMirrorBatchId,
      command,
      now,
    });
  }
  const scope = preflightScope({
    targetCount,
    confirmBroadTarget: command?.confirmBroadTarget === true,
    criticalConfirmationText: command?.criticalConfirmationText,
    previewRequiresConfirmation:
      previewRecord?.value?.broadTargetAssessment?.requiresConfirmation === true
      || previewRecord?.value?.requiresConfirmation === true,
  });
  if (scope.broad) {
    warnings.push({ code: "BROAD_TARGET", targetCount: scope.targetCount });
  }
  preflightValues({
    rules,
    targetCount: scope.targetCount,
    confirmBroadTarget: command?.confirmBroadTarget === true,
  });
  const entitlement = preflightEntitlement({
    targetCount: scope.targetCount,
    subscription,
    scheduledAt: command?.scheduledAt,
  });
  return {
    passed: true,
    warnings,
    targetCount: scope.targetCount,
    maxProducts: entitlement.maxProducts,
    checkedAt: now.toISOString(),
  };
}
