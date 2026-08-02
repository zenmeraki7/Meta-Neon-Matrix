import crypto from "crypto";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import {
  freezeExplicitTargetSet,
  markPreviewExecutionMismatch,
} from "./productTargetingService.js";
import { deriveTargetGranularityFromRules } from "./helpers/bulkEditOperationHelpers.js";

export class BulkEditTargetFreezeService {
  async freezeEditHistoryTargets({ db, historyId, shop }) {
    if (!shop) throw new Error("SHOP_SCOPE_REQUIRED");
    const history = await db.editHistory.findUnique({
      where: { shop_id: { shop, id: historyId } },
      select: {
        shop: true,
        rules: true,
        normalizedFilterHash: true,
        legacyQueryFilter: true,
        targetProductMirrorBatchId: true,
        batch: true,
        scheduledAt: true,
        recurringRunId: true,
      },
    });

    if (!history) {
      throw new Error("Edit history not found");
    }

    const explicitTargets = Array.isArray(history.batch?.automaticRuleAffectedTargets)
      ? history.batch.automaticRuleAffectedTargets
      : [];
    const explicitProductIds = Array.isArray(history.batch?.explicitProductIds)
      ? history.batch.explicitProductIds.filter(Boolean)
      : [];
    const isAutomaticRuleHistory = Boolean(history.batch?.automaticRuleTargetType);
    if (isAutomaticRuleHistory && !explicitTargets.length) {
      throw new Error("Automatic rule history requires explicit frozen targets");
    }
    if (explicitProductIds.length > 0) {
      const explicitFreezeStats = await freezeExplicitTargetSet({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        source: "MANUAL_SELECTION",
        mirrorBatchId: history.targetProductMirrorBatchId,
        normalizedFilterHash: crypto
          .createHash("sha256")
          .update(JSON.stringify(explicitProductIds))
          .digest("hex"),
        targetGranularity: "PRODUCT",
        targets: explicitProductIds.map((productId) => ({
          productId,
          targetResourceType: "PRODUCT",
        })),
        returnStats: true,
        db,
      });
      return Number(explicitFreezeStats?.finalSnapshotCount || 0);
    }
    const scheduledFreezeMode = String(history.batch?.freezeMode || "").toUpperCase();
    const isRecurringRun = Boolean(history.recurringRunId);
    const derivedGranularity = String(
      history.batch?.executionPlan?.targetResourceType
      || history.batch?.targetGranularity
      || deriveTargetGranularityFromRules(history.rules),
    ).toUpperCase() === "VARIANT"
      ? "VARIANT"
      : "PRODUCT";
    const useScheduledCreateFreeze =
      Boolean(history.scheduledAt) && scheduledFreezeMode === "STATIC_AT_SCHEDULE_CREATE";
    const freezeResolver = isRecurringRun
      ? TargetingEngineService.resolveAndFreezeRecurringRunTargets
      : useScheduledCreateFreeze
        ? TargetingEngineService.resolveAndFreezeScheduledTargets
        : TargetingEngineService.resolveAndFreezeExecutionTargets;

    const mutationIntent = {
      operationType: "BULK_EDIT",
      mutationType: "PRODUCT_SET",
      operationKey: history.batch?.operationKey || history.batch?.executionPlan?.operationKey || null,
      confirmDestructive: history.batch?.confirmDestructive === true,
      criticalConfirmationText: String(history.batch?.criticalConfirmationText || "").trim() || null,
      undoAvailability: history.undo?.allowed !== false,
      verificationMode: "SAMPLE_PLUS_FAILURES",
      allowNonActiveProducts: history.batch?.allowNonActiveProducts === true,
      fieldsBeingEdited: Array.isArray(history.rules)
        ? history.rules.map((rule) => rule?.field).filter(Boolean)
        : [],
      mutationPayload: {
        rules: Array.isArray(history.rules) ? history.rules : null,
        locationId: history.batch?.locationId || null,
        destructive: Array.isArray(history.rules)
          ? history.rules.some((rule) => String(rule?.field || "") === "deleteProducts")
          : false,
      },
      targetGranularity: String(history.batch?.automaticRuleTargetType || derivedGranularity).toUpperCase(),
      normalizedFilterHash: history.normalizedFilterHash || null,
      mirrorBatchId: history.targetProductMirrorBatchId || null,
      previewCount: Number(history.batch?.previewCount || 0),
    };
    const explicitFreezeStats = explicitTargets.length
      ? await freezeExplicitTargetSet({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        source: "AUTOMATIC_RULE_RUN",
        mirrorBatchId: history.targetProductMirrorBatchId,
        normalizedFilterHash: crypto.createHash("sha256")
          .update(JSON.stringify(explicitTargets))
          .digest("hex"),
        targetGranularity: isAutomaticRuleHistory
          ? String(history.batch?.automaticRuleTargetType || "PRODUCT").toUpperCase()
          : "PRODUCT",
        targets: explicitTargets,
        returnStats: true,
        db,
      })
      : (await freezeResolver({
        shop: history.shop,
        source: isRecurringRun
          ? "RECURRING"
          : history.scheduledAt
            ? "SCHEDULED"
            : "BULK_EDIT",
        targetResourceType: derivedGranularity === "VARIANT" ? "VARIANT" : "PRODUCT",
        targetGranularity: derivedGranularity,
        filterAst: history.batch?.filterAst ?? null,
        legacyFilterParams: Array.isArray(history.batch?.rawFilterInput)
          ? history.batch.rawFilterInput
          : [],
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        maxTargetCount: Number(history.batch?.maxBulkEditTargets || 0) || null,
        mutationIntent,
        requireBroadTargetConfirmation: true,
        confirmBroadTarget: history.batch?.confirmBroadTarget === true,
        queryParams: { cursor: null, limit: 1 },
        sampleLimit: 1,
        db,
      })).freezeStats;
    const frozenCount = Number(explicitFreezeStats?.finalSnapshotCount || 0);

    const previewCount = history.batch?.previewCount ?? null;
    if (previewCount !== null && Number(previewCount) !== Number(frozenCount)) {
      await markPreviewExecutionMismatch({
        shop: history.shop,
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        previewCount: Number(previewCount),
        frozenCount,
      });
    }

    return frozenCount;
  }
}
