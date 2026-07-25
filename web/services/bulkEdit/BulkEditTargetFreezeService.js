import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import {
  freezeExplicitTargetSnapshot,
  markPreviewExecutionMismatch,
} from "../productService/productTargetingService.js";
import { upsertFrozenSnapshotSetFromLegacy } from "../../repositories/targetSnapshotSetRepository.js";
import { guardedEditHistoryUpdate } from "../operationTransitionGuards.js";

async function attachFrozenSnapshotRefToFreezingHistory({
  db,
  historyId,
  history,
  snapshotSet,
}) {
  if (String(snapshotSet?.status || "").toUpperCase() !== "FROZEN") {
    throw new Error("SNAPSHOT_SET_NOT_FROZEN");
  }

  const existingSnapshotSetId = String(
    history?.batch?.targetSnapshotRef?.snapshotSetId || "",
  ).trim();
  const existingLifecycleSnapshotSetId = String(history?.snapshotSetId || "").trim();
  if (existingSnapshotSetId || existingLifecycleSnapshotSetId) {
    throw new Error("SNAPSHOT_SET_ALREADY_ATTACHED");
  }

  const updated = await guardedEditHistoryUpdate({
    id: historyId,
    shop: history.shop,
    expectedExecutionStates: ["TARGET_FREEZING"],
    extraWhere: {
      snapshotSetId: null,
    },
    data: {
      snapshotSetId: snapshotSet.id,
      batch: {
        ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
        targetsFrozenAt: new Date().toISOString(),
        targetSnapshotRef: {
          snapshotSetId: snapshotSet.id,
          operationId: snapshotSet.operationId,
          status: snapshotSet.status,
          targetSetHash: snapshotSet.targetSetHash || null,
        },
      },
    },
    db,
  });
  if (!updated) {
    const error = new Error("Operation transition conflict");
    error.code = "OPERATION_STAGE_CONFLICT";
    throw error;
  }
}

export class BulkEditTargetFreezeService {
  constructor(session = null) {
    this.session = session;
  }

  async freezeEditHistoryTargets(historyId, options = {}) {
    const database = options?.tx || db;

    const history = await database.editHistory.findUnique({
      where: { id: historyId },
      select: {
        shop: true,
        rules: true,
        normalizedFilterHash: true,
        legacyQueryFilter: true,
        targetProductMirrorBatchId: true,
        batch: true,
        snapshotSetId: true,
        executionState: true,
        executionIdentity: true,
        scheduledAt: true,
        recurringRunId: true,
        undo: true,
      },
    });

    if (!history) {
      throw new Error("Edit history not found");
    }

    const explicitProductIds = Array.isArray(history.batch?.explicitProductIds)
      ? history.batch.explicitProductIds.filter(Boolean)
      : [];

    const previewRows = Array.isArray(history.batch?.previewRows)
      ? history.batch.previewRows.filter((row) =>
        String(row?.status || "").toUpperCase() === "READY",
      )
      : [];

    if (previewRows.length > 0) {
      const targetGranularity = String(
        history.batch?.targetGranularity || "VARIANT",
      ).toUpperCase();
      const stats = await freezeExplicitTargetSnapshot({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        source: "MANUAL_PREVIEW",
        mirrorBatchId: history.targetProductMirrorBatchId,
        normalizedFilterHash: String(
          history.batch?.previewFingerprint?.normalizedFilterHash ||
          history.normalizedFilterHash ||
          history.batch?.previewId ||
          historyId,
        ),
        targetGranularity,
        targets: previewRows.map((row) => ({
          productId: row.productId,
          variantId: row.variantId || null,
          targetResourceType: row.targetResourceType || (row.variantId ? "VARIANT" : "PRODUCT"),
          beforeValues: {
            ...(row.beforeValues && typeof row.beforeValues === "object"
              ? row.beforeValues
              : {}),
            currentValue: row.currentValue ?? null,
            newValue: row.newValue ?? null,
            plannedMutation: row.plannedMutation || null,
          },
          plannedMutation: row.plannedMutation || null,
        })),
        returnStats: true,
        db: database,
      });

      const frozenCount = Number(stats?.finalSnapshotCount || 0);
      const snapshotSet = await upsertFrozenSnapshotSetFromLegacy({
        shop: history.shop,
        historyId,
        operationId: String(history.executionIdentity || "").trim() || `EDIT_HISTORY:${historyId}`,
        previewContractId: String(history.batch?.previewContractId || history.batch?.previewId || "").trim() || `EDIT_HISTORY:${historyId}`,
        mirrorBatchId: history.targetProductMirrorBatchId,
        targetDefinitionHash: String(history.batch?.previewFingerprint?.normalizedFilterHash || history.normalizedFilterHash || "").trim() || null,
        compilerVersion: String(history.batch?.targetingCompilerVersion || "preview-v1"),
        projectionVersion: "preview-v1",
        plannerVersion: String(history.batch?.executionPlan?.plannerVersion || history.batch?.plannerVersion || "").trim() || null,
        source: "MANUAL_PREVIEW",
        db: database,
      });
      await attachFrozenSnapshotRefToFreezingHistory({
        db: database,
        historyId,
        history,
        snapshotSet,
      });
      return frozenCount;
    }

    if (explicitProductIds.length > 0) {
      const stats = await freezeExplicitTargetSnapshot({
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
        db: database,
      });

      const frozenCount = Number(stats?.finalSnapshotCount || 0);
      const snapshotSet = await upsertFrozenSnapshotSetFromLegacy({
        shop: history.shop,
        historyId,
        operationId: String(history.executionIdentity || "").trim() || `EDIT_HISTORY:${historyId}`,
        previewContractId: String(history.batch?.previewContractId || history.batch?.previewId || "").trim() || `EDIT_HISTORY:${historyId}`,
        mirrorBatchId: history.targetProductMirrorBatchId,
        targetDefinitionHash: String(history.normalizedFilterHash || "").trim() || null,
        compilerVersion: String(history.batch?.targetingCompilerVersion || "legacy-v1"),
        projectionVersion: "legacy-v1",
        plannerVersion: String(history.batch?.executionPlan?.plannerVersion || history.batch?.plannerVersion || "").trim() || null,
        source: "MANUAL_SELECTION",
        db: database,
      });
      await attachFrozenSnapshotRefToFreezingHistory({
        db: database,
        historyId,
        history,
        snapshotSet,
      });
      return frozenCount;
    }

    const explicitTargets = Array.isArray(
      history.batch?.automaticRuleAffectedTargets,
    )
      ? history.batch.automaticRuleAffectedTargets
      : [];

    const isAutomaticRuleHistory = Boolean(history.batch?.automaticRuleTargetType);

    if (isAutomaticRuleHistory && !explicitTargets.length) {
      throw new Error("Automatic rule history requires explicit frozen targets");
    }

    const scheduledFreezeMode = String(
      history.batch?.freezeMode || "",
    ).toUpperCase();

    const isRecurringRun = Boolean(history.recurringRunId);

    const useScheduledCreateFreeze =
      Boolean(history.scheduledAt) &&
      scheduledFreezeMode === "STATIC_AT_SCHEDULE_CREATE";

    const targetGranularity = String(
      history.batch?.targetGranularity ||
      history.batch?.automaticRuleTargetType ||
      "PRODUCT",
    ).toUpperCase();

    const mutationIntent = {
      operationType: "BULK_EDIT",
      mutationType: "PRODUCT_SET",
      operationKey:
        history.batch?.operationKey ||
        history.batch?.executionPlan?.operationKey ||
        null,
      confirmDestructive: history.batch?.confirmDestructive === true,
      criticalConfirmationText:
        String(history.batch?.criticalConfirmationText || "").trim() || null,
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
          ? history.rules.some(
            (rule) => String(rule?.field || "") === "deleteProducts",
          )
          : false,
      },
      targetGranularity,
      normalizedFilterHash: history.normalizedFilterHash || null,
      mirrorBatchId: history.targetProductMirrorBatchId || null,
      previewCount: Number(history.batch?.previewCount || 0),
    };

    const freezeResolver = isRecurringRun
      ? TargetingEngineService.resolveAndFreezeRecurringRunTargets
      : useScheduledCreateFreeze
        ? TargetingEngineService.resolveAndFreezeScheduledTargets
        : TargetingEngineService.resolveAndFreezeExecutionTargets;

    const freezeStats = explicitTargets.length
      ? await freezeExplicitTargetSnapshot({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        source: "AUTOMATIC_RULE_RUN",
        mirrorBatchId: history.targetProductMirrorBatchId,
        normalizedFilterHash: crypto
          .createHash("sha256")
          .update(JSON.stringify(explicitTargets))
          .digest("hex"),
        targetGranularity,
        targets: explicitTargets,
        returnStats: true,
        db: database,
      })
      : (
        await freezeResolver({
          shop: history.shop,
          source: isRecurringRun
            ? "RECURRING"
            : history.scheduledAt
              ? "SCHEDULED"
              : "BULK_EDIT",
          targetResourceType: targetGranularity,
          targetGranularity,
          filterAst: history.batch?.filterAst ?? null,
          legacyFilterParams: Array.isArray(history.batch?.rawFilterInput)
            ? history.batch.rawFilterInput
            : [],
          ownerType: "EDIT_HISTORY",
          ownerId: historyId,
          maxTargetCount:
            Number(history.batch?.maxBulkEditTargets || 0) || null,
          mutationIntent,
          requireBroadTargetConfirmation: true,
          confirmBroadTarget: history.batch?.confirmBroadTarget === true,
          queryParams: { cursor: null, limit: 1 },
          sampleLimit: 1,
          db: database,
        })
      ).freezeStats;

    const frozenCount = Number(freezeStats?.finalSnapshotCount || 0);
    const previewCount = history.batch?.previewCount ?? null;

    if (previewCount !== null && Number(previewCount) !== frozenCount) {
      await markPreviewExecutionMismatch({
        shop: history.shop,
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        previewCount: Number(previewCount),
        frozenCount,
      });
    }

    const snapshotSet = await upsertFrozenSnapshotSetFromLegacy({
      shop: history.shop,
      historyId,
      operationId: String(history.executionIdentity || "").trim() || `EDIT_HISTORY:${historyId}`,
      previewContractId: String(history.batch?.previewContractId || history.batch?.previewId || "").trim() || `EDIT_HISTORY:${historyId}`,
      mirrorBatchId: history.targetProductMirrorBatchId,
      targetDefinitionHash: String(history.normalizedFilterHash || "").trim() || null,
      compilerVersion: String(history.batch?.targetingCompilerVersion || "legacy-v1"),
      projectionVersion: "legacy-v1",
      plannerVersion: String(history.batch?.executionPlan?.plannerVersion || history.batch?.plannerVersion || "").trim() || null,
      source: "BULK_EDIT",
      db: database,
    });

    await attachFrozenSnapshotRefToFreezingHistory({
      db: database,
      historyId,
      history,
      snapshotSet,
    });

    return frozenCount;
  }
}
