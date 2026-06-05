import crypto from "crypto";
import { db as defaultDb } from "../../repositories/repositoryDb.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import {
  freezeExplicitTargetSnapshot,
  markPreviewExecutionMismatch,
} from "../productService/productTargetingService.js";
import { upsertFrozenSnapshotSetFromLegacy } from "../../repositories/targetSnapshotSetRepository.js";
import { guardedEditHistoryUpdate } from "../operationTransitionGuards.js";

const TARGET_SNAPSHOT_PROJECTION_VERSION = "target-freeze-v2";
const FALLBACK_TARGETING_COMPILER_VERSION = "legacy-v1";
const LEGACY_FILTER_PARAMS_ALLOWED_FOR_RECURRING_ONLY = true;

function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function sha256Json(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function requireExecutionIdentity(history) {
  const executionIdentity = normalizeOptionalString(history?.executionIdentity);
  if (!executionIdentity) {
    const error = new Error("TARGET_FREEZE_REQUIRES_EXECUTION_IDENTITY");
    error.code = "TARGET_FREEZE_REQUIRES_EXECUTION_IDENTITY";
    throw error;
  }
  return executionIdentity;
}

function resolveSnapshotSetArgs({
  history,
  historyId,
  source,
}) {
  return {
    shop: history.shop,
    historyId,
    operationId: requireExecutionIdentity(history),
    previewContractId:
      normalizeOptionalString(history.batch?.previewContractId || history.batch?.previewId)
      || `EDIT_HISTORY:${historyId}`,
    mirrorBatchId: history.targetMirrorBatchId,
    targetingFingerprint: normalizeOptionalString(history.filterHash),
    compilerVersion:
      normalizeOptionalString(history.batch?.targetingCompilerVersion)
      || FALLBACK_TARGETING_COMPILER_VERSION,
    projectionVersion: TARGET_SNAPSHOT_PROJECTION_VERSION,
    plannerVersion:
      normalizeOptionalString(
        history.batch?.executionPlan?.plannerVersion || history.batch?.plannerVersion,
      ),
    source,
  };
}

function resolveOperationIntentName(history) {
  return normalizeOptionalString(
    history.batch?.operationKey
      || history.batch?.executionPlan?.operationKey
      || history.batch?.executionPlan?.mutationType
      || history.batch?.executionPlan?.graphqlMutationName,
  ) || "BULK_EDIT";
}

function resolveFreezeResolver({
  targetingEngine,
  isRecurringRun,
  useScheduledCreateFreeze,
}) {
  const resolverName = isRecurringRun
    ? "resolveAndFreezeRecurringRunTargets"
    : useScheduledCreateFreeze
      ? "resolveAndFreezeScheduledTargets"
      : "resolveAndFreezeExecutionTargets";
  const resolver = targetingEngine?.[resolverName];
  if (typeof resolver !== "function") {
    const error = new Error(`TARGET_FREEZE_RESOLVER_MISSING:${resolverName}`);
    error.code = "TARGET_FREEZE_RESOLVER_MISSING";
    throw error;
  }
  return { resolverName, resolver: resolver.bind(targetingEngine) };
}

async function assertPreviewCountMatches({
  history,
  historyId,
  frozenCount,
  markMismatch,
}) {
  const previewCount = history.batch?.previewCount ?? null;
  if (previewCount === null || Number(previewCount) === Number(frozenCount)) return;

  await markMismatch({
    shop: history.shop,
    ownerType: "EDIT_HISTORY",
    ownerId: historyId,
    previewCount: Number(previewCount),
    frozenCount: Number(frozenCount),
  });

  const error = new Error("PREVIEW_EXECUTION_TARGET_COUNT_MISMATCH");
  error.code = "PREVIEW_EXECUTION_TARGET_COUNT_MISMATCH";
  error.meta = {
    previewCount: Number(previewCount),
    frozenCount: Number(frozenCount),
  };
  throw error;
}

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
          checksum: snapshotSet.checksum || null,
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
  constructor(session = null, dependencies = {}) {
    this.session = session;
    this.db = dependencies.db || defaultDb;
    this.targetingEngine = dependencies.targetingEngine || TargetingEngineService;
    this.freezeExplicitTargetSnapshot =
      dependencies.freezeExplicitTargetSnapshot || freezeExplicitTargetSnapshot;
    this.markPreviewExecutionMismatch =
      dependencies.markPreviewExecutionMismatch || markPreviewExecutionMismatch;
    this.upsertFrozenSnapshotSetFromLegacy =
      dependencies.upsertFrozenSnapshotSetFromLegacy || upsertFrozenSnapshotSetFromLegacy;
    this.attachFrozenSnapshotRefToFreezingHistory =
      dependencies.attachFrozenSnapshotRefToFreezingHistory || attachFrozenSnapshotRefToFreezingHistory;
  }

  async freezeEditHistoryTargets(historyId, options = {}) {
    const shop = String(options?.shop || this.session?.shop || "").trim();
    if (!shop || !historyId) {
      throw new Error("TARGET_FREEZE_REQUIRES_SHOP_AND_HISTORY_ID");
    }

    return this.db.$transaction(async (db) => {
    const history = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        shop: true,
        rules: true,
        filterHash: true,
        queryFilter: true,
        targetMirrorBatchId: true,
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
    requireExecutionIdentity(history);

    const explicitProductIds = Array.isArray(history.batch?.explicitProductIds)
      ? history.batch.explicitProductIds.filter(Boolean)
      : [];
    let freezeStats = null;
    let snapshotSource = "BULK_EDIT";

    if (explicitProductIds.length > 0) {
      freezeStats = await this.freezeExplicitTargetSnapshot({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        source: "MANUAL_SELECTION",
        mirrorBatchId: history.targetMirrorBatchId,
        filterHash: sha256Json(explicitProductIds),
        targetGranularity: "PRODUCT",
        targets: explicitProductIds.map((productId) => ({
          productId,
          targetType: "PRODUCT",
        })),
        returnStats: true,
        db,
      });
      snapshotSource = "MANUAL_SELECTION";
    } else {
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
      mutationType: resolveOperationIntentName(history),
      operationKey: resolveOperationIntentName(history),
      confirmDestructive: history.batch?.confirmDestructive === true,
      criticalConfirmationText:
        normalizeOptionalString(history.batch?.criticalConfirmationText),
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
      filterHash: normalizeOptionalString(history.filterHash),
      mirrorBatchId: normalizeOptionalString(history.targetMirrorBatchId),
      previewCount: Number(history.batch?.previewCount || 0),
    };

    const { resolver: freezeResolver } = resolveFreezeResolver({
      targetingEngine: this.targetingEngine,
      isRecurringRun,
      useScheduledCreateFreeze,
    });

      freezeStats = explicitTargets.length
      ? await this.freezeExplicitTargetSnapshot({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        source: "AUTOMATIC_RULE_RUN",
        mirrorBatchId: history.targetMirrorBatchId,
        filterHash: sha256Json(explicitTargets),
        targetGranularity,
        targets: explicitTargets,
        returnStats: true,
        db,
      })
      : (
        await freezeResolver({
          shop: history.shop,
          source: isRecurringRun
            ? "RECURRING"
            : history.scheduledAt
              ? "SCHEDULED"
              : "BULK_EDIT",
          targetType: targetGranularity,
          targetGranularity,
          filterAst: history.batch?.filterAst ?? null,
          legacyFilterParams: (
            LEGACY_FILTER_PARAMS_ALLOWED_FOR_RECURRING_ONLY
            && isRecurringRun
            && !history.batch?.filterAst
            && Array.isArray(history.batch?.filterParams)
          )
            ? history.batch.filterParams
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
          db,
        })
      ).freezeStats;
      snapshotSource = explicitTargets.length ? "AUTOMATIC_RULE_RUN" : "BULK_EDIT";
    }

    const frozenCount = Number(freezeStats?.finalSnapshotCount || 0);

    await assertPreviewCountMatches({
      history,
      historyId,
      frozenCount,
      markMismatch: this.markPreviewExecutionMismatch,
    });

    const snapshotSet = await this.upsertFrozenSnapshotSetFromLegacy({
      ...resolveSnapshotSetArgs({
        history,
        historyId,
        source: snapshotSource,
      }),
      db,
    });

    await this.attachFrozenSnapshotRefToFreezingHistory({
      db,
      historyId,
      history,
      snapshotSet,
    });

    return frozenCount;
    });
  }
}
