import crypto from "crypto";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  buildActorContext,
  buildEntitlementSnapshot,
} from "../../utils/operationContextUtils.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { computeBlastRadiusRisk } from "../targeting/validate/mutationIntentPreflightValidator.js";
import { buildImmutableEditCommand } from "./immutableEditCommand.js";
import { enqueueBulkEditTargetFreezeJob } from "../../Jobs/Queues/bulkEditPipelineJob.js";
import {
  buildEditIntentFromRules,
  buildHistoryTitle,
  normalizeRules,
  resolveTargetGranularityFromRules,
} from "./bulkEditRuleUtils.js";
import {
  buildExecutionPlanForEdit,
  getPlanMaxBulkEditTargets,
} from "./bulkEditPlanUtils.js";
import { buildPlannedUndoState } from "../bulkEditExecutionStateService.js";
import { loadAuthoritativeSubscriptionForShop } from "../subscriptionAuthorityService.js";
import { assertMirrorSafeForTargeting } from "../mirrorHealthService.js";
import {
  buildIdempotencyRequestHash,
} from "../idempotency/IdempotencyStoreService.js";
import { createIdempotencyStore } from "../../repositories/idempotencyRepository.js";
import {
  createManualEditHistoryWithImmutableCommand,
  findPreviewContractRecord,
  markManualEditHistoryEnqueueFailed,
} from "../../repositories/bulkEditCommandRepository.js";

const BULK_EDIT_HISTORY_CACHE_KEYS = [
  "fetchHistories",
  "sync_details",
  "sync_summary",
  "sync_summary:v2",
];

function resolveSessionActorContext(session) {
  return buildActorContext({
    session,
    fallbackType: "MERCHANT_ADMIN",
  });
}

async function clearBulkEditHistoryCaches(shop) {
  await Promise.all(
    BULK_EDIT_HISTORY_CACHE_KEYS.map((key) => clearKeyCaches(`${shop}:${key}`)),
  );
}

function resolveShopPlanLimits(subscription = {}) {
  const limits = subscription?.shopPlanLimits
    || subscription?.planLimits
    || subscription?.limits
    || {};
  if (limits && typeof limits === "object" && !Array.isArray(limits)) {
    return limits;
  }
  return {};
}

export class BulkEditCommandService {
  constructor(session) {
    this.session = session;
    this.idempotencyStore = createIdempotencyStore();
  }

  async createManualBulkEditOperation(input = {}) {
    if (!this.session?.shop) {
      throw new Error("BULK_EDIT_COMMAND_REQUIRES_SHOP_SESSION");
    }

    const command = input.command || {};
    const idempotencyKey = String(input.idempotencyKey || "").trim();
    if (!idempotencyKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    const actor = resolveSessionActorContext(this.session);
    const authoritativeSubscription = await loadAuthoritativeSubscriptionForShop(
      this.session.shop,
    );

    const historyData = await this.#buildManualHistoryData(
      command,
      authoritativeSubscription,
      {
        actor,
        entitlementSnapshot: buildEntitlementSnapshot(authoritativeSubscription),
      },
    );

    const begin = await this.idempotencyStore.begin({
      shop: this.session.shop,
      scope: "BULK_EDIT_EXECUTE",
      key: idempotencyKey,
      requestHash: buildIdempotencyRequestHash({
        shop: this.session.shop,
        command,
      }),
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    const { historyId, historyShop, executionIdentity } =
      await createManualEditHistoryWithImmutableCommand({
        historyData,
        buildImmutableEditCommandForHistory: (history) =>
          buildImmutableEditCommand({
            operationType: "BULK_PRODUCT_EDIT",
            shop: history.shop,
            actorUserId: history.actorId || null,
            edit: buildEditIntentFromRules(history.rules),
            targetSnapshotSetId: `EDIT_HISTORY:${history.id}`,
          }),
      });

    try {
      await enqueueBulkEditTargetFreezeJob({
        historyId,
        shop: historyShop,
        source: "manual_bulk_edit_pipeline",
        executionId: executionIdentity,
      });
    } catch (error) {
      await markManualEditHistoryEnqueueFailed({
        historyId,
        shop: historyShop,
        executionIdentity,
        errorMessage: error?.message,
      });
      await this.idempotencyStore.abort({
        recordId: begin.recordId,
        shop: this.session.shop,
      });
      await clearBulkEditHistoryCaches(historyShop);
      throw error;
    }

    await clearBulkEditHistoryCaches(historyShop);

    const response = {
      success: true,
      id: historyId,
      operationId: historyId,
      status: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      message: "Bulk edit has been queued.",
    };
    await this.idempotencyStore.complete({
      recordId: begin.recordId,
      shop: this.session.shop,
      response,
    });
    return response;
  }

  async buildSystemEditHistoryData(body = {}, subscription = {}, operationContext = {}) {
    if (!this.session?.shop) {
      throw new Error("BULK_EDIT_COMMAND_REQUIRES_SHOP_SESSION");
    }

    const rules = normalizeRules(body);
    const targetGranularity =
      String(body.targetGranularity || body.targetType || "").trim()
      || resolveTargetGranularityFromRules(rules);
    const explicitTargets = Array.isArray(body.explicitTargets)
      ? body.explicitTargets.filter(Boolean)
      : [];
    const explicitProductIds = Array.isArray(body.productIds)
      ? body.productIds.filter(Boolean)
      : [];
    const explicitVariantIds = Array.isArray(body.variantIds)
      ? body.variantIds.filter(Boolean)
      : [];
    const targetCount = explicitTargets.length
      || explicitVariantIds.length
      || explicitProductIds.length
      || Number(body.targetCount || 0);
    const queryWhere =
      body.queryWhere && typeof body.queryWhere === "object"
        ? body.queryWhere
        : (body.where && typeof body.where === "object" ? body.where : {});
    const filterAst =
      body.filterAst && typeof body.filterAst === "object"
        ? body.filterAst
        : null;
    const locationId = body.locationId ?? body.location ?? null;
    const title = body.title || await buildHistoryTitle(rules);
    const executionPlan = buildExecutionPlanForEdit({
      operationKey: body.operationKey || null,
      shop: this.session.shop,
      planType: body.planType || "BULK_EDIT",
      rules,
      targetGranularity,
      targetCount,
      shopPlanLimits: resolveShopPlanLimits(subscription),
    });
    const undoAllowed = !rules.some((rule) => rule.field === "deleteProducts");
    const blastRadiusAssessment = computeBlastRadiusRisk({
      targetCount,
      totalCatalogCount: Number(body.totalCatalogCount || targetCount || 0),
      fieldsEdited: rules.map((rule) => rule?.field).filter(Boolean),
      destructiveNature: !undoAllowed,
      undoAvailability: undoAllowed,
      verificationMode: "SAMPLE_PLUS_FAILURES",
    });

    return {
      shop: this.session.shop,
      title,
      queryFilter: JSON.stringify(queryWhere),
      rules,
      startedAt: new Date(),
      status: "pending",
      statusNormalized: normalizeEditHistoryStatus("pending"),
      executionState: OPERATION_LIFECYCLE_STATES.PLANNING,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.PLANNING,
      ),
      executionIdentity: crypto.randomUUID(),
      processedCount: 0,
      totalItems: targetCount,
      targetSnapshotCount: 0,
      targetMirrorBatchId: body.targetMirrorBatchId || null,
      durationMs: 0,
      batch: {
        frozen: false,
        hasMore: targetCount > 0,
        lastProductId: null,
        size: executionPlan.batchSize,
        previewCount: targetCount,
        currentBatchTargetCount: 0,
        queuedAt: new Date().toISOString(),
        filterParams: Array.isArray(body.filterParams) ? body.filterParams : [],
        filterAst,
        maxBulkEditTargets: getPlanMaxBulkEditTargets(subscription),
        executionPlan,
        operationKey: executionPlan.operationKey,
        explicitProductIds,
        explicitVariantIds,
        explicitTargets,
        explicitWhere: queryWhere,
        targetGranularity,
        locationId: locationId || null,
        blastRadiusAssessment,
      },
      ...(rules.some((rule) => rule.field === "inventory") && { locationId }),
      entitlementSnapshot: operationContext.entitlementSnapshot || null,
      actorType: operationContext.actor?.actorType || null,
      actorId: operationContext.actor?.actorId || null,
      actorEmail: operationContext.actor?.actorEmail || null,
      actorName: operationContext.actor?.actorName || null,
      undo: buildPlannedUndoState({ allowed: undoAllowed }),
    };
  }

  async #buildManualHistoryData(body, subscription, operationContext = {}) {
    const locationId = body.locationId ?? body.location ?? null;
    const previewContractId = body.previewContractId ?? body.previewId;
    const {
      editedField,
      confirmBroadTarget,
      criticalConfirmationText,
      operationKey,
      title: explicitTitle,
    } = body;

    if (!previewContractId) {
      throw new Error("Preview is required before execute. Please run preview again.");
    }

    const previewRecord = await findPreviewContractRecord(
      previewContractId,
      this.session.shop,
    );

    if (!previewRecord) {
      throw new Error("Preview session expired. Please re-preview before executing.");
    }
    if (previewRecord.expiresAt && previewRecord.expiresAt < new Date()) {
      throw new Error("PREVIEW_EXPIRED");
    }

    const fingerprint = previewRecord.value || {};
    const resolvedEditedField = editedField ?? fingerprint.field;
    const resolvedEditType = body.editType ?? fingerprint.editType;
    const resolvedEditValue =
      body.editValue !== undefined ? body.editValue : fingerprint.editValue;
    const resolvedSearchKey = body.searchKey ?? fingerprint.searchKey ?? null;
    const resolvedReplaceText = body.replaceText ?? fingerprint.replaceText ?? null;
    const resolvedSupportValue =
      body.supportValue !== undefined ? body.supportValue : fingerprint.supportValue;

    const rules = normalizeRules({
      ...body,
      editedField: resolvedEditedField,
      editType: resolvedEditType,
      editValue: resolvedEditValue,
      searchKey: resolvedSearchKey,
      replaceText: resolvedReplaceText,
      supportValue: resolvedSupportValue,
    });

    if (resolvedEditedField === "inventory" && !locationId) {
      throw new Error("Location ID is required for inventory edits");
    }

    const previewActorId = String(
      previewRecord.userId
      || previewRecord?.value?.actorId
      || "",
    ).trim();
    const executionActorId = String(
      operationContext.actor?.actorId || "",
    ).trim();
    if (!previewActorId) {
      throw new Error("PREVIEW_OWNERSHIP_UNBOUND");
    }
    if (!executionActorId) {
      throw new Error("ACTOR_ID_REQUIRED_FOR_EXECUTE");
    }
    if (executionActorId !== previewActorId) {
      throw new Error("PREVIEW_ACTOR_MISMATCH");
    }

    const expectedHash = String(fingerprint.filterHash || "");
    const expectedBatch = String(fingerprint.mirrorBatchId || "");
    if (!expectedHash || !expectedBatch) {
      throw new Error("PREVIEW_FINGERPRINT_INCOMPLETE");
    }

    const mirrorState = await assertMirrorSafeForTargeting(this.session.shop, {
      purpose: "EXECUTE",
    });
    const activeMirrorBatchId = String(mirrorState?.activeMirrorBatchId || "");
    if (activeMirrorBatchId !== expectedBatch) {
      throw new Error("Preview is stale. Please re-preview before executing.");
    }

    const targetGranularity =
      String(fingerprint.targetGranularity || "").trim()
      || resolveTargetGranularityFromRules(rules);

    const previewWhere =
      fingerprint.where && typeof fingerprint.where === "object"
        ? fingerprint.where
        : null;
    const previewCount = Number(fingerprint.count);
    const previewFilterAst =
      fingerprint.filterAst && typeof fingerprint.filterAst === "object"
        ? fingerprint.filterAst
        : null;
    const previewBroadTargetAssessment =
      fingerprint.broadTargetAssessment
      && typeof fingerprint.broadTargetAssessment === "object"
        ? fingerprint.broadTargetAssessment
        : null;

    if (
      !previewWhere
      || !Number.isFinite(previewCount)
      || previewCount < 0
    ) {
      throw new Error("PREVIEW_SNAPSHOT_INCOMPLETE");
    }

    const count = previewCount;
    const maxBulkEditTargets = getPlanMaxBulkEditTargets(subscription);

    if (count > maxBulkEditTargets) {
      throw new Error("TARGET_COUNT_EXCEEDS_PLAN_LIMIT");
    }

    const title = explicitTitle || await buildHistoryTitle(rules);

    const executionPlan = buildExecutionPlanForEdit({
      operationKey,
      shop: this.session.shop,
      planType: "BULK_EDIT",
      rules,
      targetGranularity,
      targetCount: count,
      shopPlanLimits: resolveShopPlanLimits(subscription),
    });

    const blastRadiusAssessment = computeBlastRadiusRisk({
      targetCount: count,
      totalCatalogCount: Number(
        previewBroadTargetAssessment?.totalInBatch || 0,
      ),
      fieldsEdited: rules.map((rule) => rule?.field).filter(Boolean),
      destructiveNature: rules.some(
        (rule) => String(rule?.field || "") === "deleteProducts",
      ),
      undoAvailability: resolvedEditedField !== "deleteProducts",
      verificationMode: "SAMPLE_PLUS_FAILURES",
    });

    const providedCriticalConfirmation = String(
      criticalConfirmationText || "",
    ).trim();

    if (
      blastRadiusAssessment.riskLevel === "CRITICAL" &&
      providedCriticalConfirmation !==
        blastRadiusAssessment.requiredCriticalConfirmation
    ) {
      throw new Error(
        `CRITICAL blast radius confirmation required. Type exactly: ${blastRadiusAssessment.requiredCriticalConfirmation}`,
      );
    }

    return {
      shop: this.session.shop,
      title,
      queryFilter: JSON.stringify(previewWhere),
      rules,
      startedAt: new Date(),
      status: "pending",
      statusNormalized: normalizeEditHistoryStatus("pending"),
      executionState: OPERATION_LIFECYCLE_STATES.PLANNING,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.PLANNING,
      ),
      executionIdentity: crypto.randomUUID(),
      processedCount: 0,
      totalItems: count,
      targetSnapshotCount: 0,
      targetMirrorBatchId: expectedBatch,
      durationMs: 0,
      batch: {
        frozen: true,
        hasMore: count > 0,
        lastProductId: null,
        size: executionPlan.batchSize,
        previewCount: count,
        currentBatchTargetCount: 0,
        queuedAt: new Date().toISOString(),
        // Execute must reuse preview snapshot targeting material only.
        filterParams: [],
        filterAst: previewFilterAst,
        previewId: previewContractId,
        previewContractId,
        previewFingerprint: {
          previewId: previewContractId,
          filterHash: expectedHash,
          mirrorBatchId: expectedBatch,
        },
        maxBulkEditTargets,
        executionPlan,
        operationKey: executionPlan.operationKey,
        explicitProductIds: [],
        explicitWhere: null,
        targetGranularity,
        requiresBroadTargetConfirmation:
          previewBroadTargetAssessment?.requiresConfirmation === true,
        confirmBroadTarget: confirmBroadTarget === true,
        criticalConfirmationText:
          String(criticalConfirmationText || "").trim() || null,
        locationId: locationId || null,
        blastRadiusAssessment,
      },
      ...(resolvedEditedField === "inventory" && { locationId }),
      entitlementSnapshot: operationContext.entitlementSnapshot || null,
      actorType: operationContext.actor?.actorType || null,
      actorId: operationContext.actor?.actorId || null,
      actorEmail: operationContext.actor?.actorEmail || null,
      actorName: operationContext.actor?.actorName || null,
      undo: buildPlannedUndoState({
        allowed: resolvedEditedField !== "deleteProducts",
      }),
    };
  }
}
