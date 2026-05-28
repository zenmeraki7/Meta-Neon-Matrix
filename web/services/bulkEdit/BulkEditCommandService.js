import crypto from "crypto";
import { prisma } from "../../config/database.js";
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
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";

export class BulkEditCommandService {
  constructor(session) {
    this.session = session;
    this.idempotencyStore = new IdempotencyStoreService(prisma);
  }

  async createManualBulkEditOperation(input = {}) {
    if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "body")) {
      throw new Error("RAW_REQ_SHAPE_FORBIDDEN");
    }

    const command = input.command || {};
    const idempotencyKey = String(input.idempotencyKey || "").trim();
    if (!idempotencyKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

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

    const actor = input.actor || buildActorContext({
        req: { body: command, query: {}, headers: {} },
        session: this.session,
        fallbackType: "MERCHANT_ADMIN",
      });

    const authoritativeSubscription = await loadAuthoritativeSubscriptionForShop(
      this.session.shop,
    );

    const effectiveSubscription = input.subscription || authoritativeSubscription;

    const historyData = await this.#buildManualHistoryData(
      command,
      effectiveSubscription,
      {
        actor,
        entitlementSnapshot: buildEntitlementSnapshot(effectiveSubscription),
      },
    );

    const { historyId, historyShop, executionIdentity } =
      await prisma.$transaction(async (tx) => {
        const history = await tx.editHistory.create({
          data: {
            ...historyData,
            executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
            executionStateNormalized: normalizeEditHistoryExecutionState(
              OPERATION_LIFECYCLE_STATES.QUEUED,
            ),
          },
        });

        const immutableEditCommand = buildImmutableEditCommand({
          operationType: "BULK_PRODUCT_EDIT",
          shop: history.shop,
          actorUserId: history.actorId || null,
          edit: buildEditIntentFromRules(history.rules),
          targetSnapshotSetId: `EDIT_HISTORY:${history.id}`,
        });

        await tx.editHistory.update({
          where: { id: history.id },
          data: {
            batch: {
              ...(history.batch && typeof history.batch === "object"
                ? history.batch
                : {}),
              immutableEditCommand,
              targetSnapshotSet: {
                id: `EDIT_HISTORY:${history.id}`,
                ownerType: "EDIT_HISTORY",
                ownerId: history.id,
                sourceType: history.batch?.explicitProductIds?.length
                  ? "MANUAL_SELECTION"
                  : "FILTER",
                status: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
              },
            },
          },
        });

        return {
          historyId: history.id,
          historyShop: history.shop,
          executionIdentity: history.executionIdentity,
        };
      });

    await clearKeyCaches(`${historyShop}:fetchHistories`);

    await enqueueBulkEditTargetFreezeJob({
      historyId,
      shop: historyShop,
      source: "manual_bulk_edit_pipeline",
      executionId: executionIdentity,
    });

    const response = {
      success: true,
      id: historyId,
      operationId: historyId,
      status: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      message: "Bulk edit has been queued.",
    };
    await this.idempotencyStore.complete({
      recordId: begin.recordId,
      response,
    });
    return response;
  }

  async createEditHistoryPayload(body, subscription, operationContext = {}) {
    return this.#buildManualHistoryData(body, subscription, operationContext);
  }

  async _bulkOperationEdit(body, subscription, operationContext = {}) {
    return this.#buildManualHistoryData(body, subscription, operationContext);
  }

  async #buildManualHistoryData(body, subscription, operationContext = {}) {
    const locationId = body.locationId ?? body.location ?? null;
    const {
      editedField,
      filterParams,
      filterAst,
      previewId,
      previewFilterHash,
      previewMirrorBatchId,
      confirmBroadTarget,
      criticalConfirmationText,
      operationKey,
      queryWhere,
      productIds,
      title: explicitTitle,
    } = body;

    const rules = normalizeRules(body);

    if (editedField === "inventory" && !locationId) {
      throw new Error("Location ID is required for inventory edits");
    }

    if (!previewId) {
      throw new Error("Preview is required before execute. Please run preview again.");
    }

    const previewRecord = await prisma.filterTrack.findFirst({
      where: {
        id: String(previewId),
        shop: this.session.shop,
        type: "preview",
      },
    });

    if (!previewRecord) {
      throw new Error("Preview session expired. Please re-preview before executing.");
    }
    if (previewRecord.expiresAt && previewRecord.expiresAt < new Date()) {
      throw new Error("PREVIEW_EXPIRED");
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

    const fingerprint = previewRecord.value || {};
    const expectedHash = String(fingerprint.filterHash || "");
    const expectedBatch = String(fingerprint.mirrorBatchId || "");

    if (
      String(previewFilterHash || "") !== expectedHash ||
      String(previewMirrorBatchId || "") !== expectedBatch
    ) {
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
    const limit = subscription?.limit || 100;
    const planName = subscription?.planName || "Free Plan";
    const isUnlimited = subscription?.isUnlimited || false;

    if (!isUnlimited && count > limit) {
      throw new Error(
        `Your current plan (${planName}) allows editing up to ${limit} products at a time. You are trying to edit ${count} products. Please upgrade your plan or reduce the number of products.`,
      );
    }

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
      shopPlanLimits: { batchSize: 250 },
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
      undoAvailability: editedField !== "deleteProducts",
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
        size: 75,
        previewCount: count,
        currentBatchTargetCount: 0,
        queuedAt: new Date().toISOString(),
        // Execute must reuse preview snapshot targeting material only.
        filterParams: [],
        filterAst: previewFilterAst,
        previewId,
        previewFingerprint: {
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
      ...(editedField === "inventory" && { locationId }),
      entitlementSnapshot: operationContext.entitlementSnapshot || null,
      actorType: operationContext.actor?.actorType || null,
      actorId: operationContext.actor?.actorId || null,
      actorEmail: operationContext.actor?.actorEmail || null,
      actorName: operationContext.actor?.actorName || null,
      undo: buildPlannedUndoState({
        allowed: editedField !== "deleteProducts",
      }),
    };
  }
}
