import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { createMultiLanguage } from "../../utils/googleTranslator.js";
import { scheduledEditRunJobId } from "../../utils/jobQueueUtils.js";
import { buildPlannedUndoState } from "../bulkEditExecutionStateService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import { computeBlastRadiusRisk } from "../targeting/validate/mutationIntentPreflightValidator.js";
import { getUpdatedProducts } from "../../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import { buildImmutableEditCommand } from "../bulkEdit/immutableEditCommand.js";
import {
  createEnqueueIntent,
  dispatchPendingEnqueueIntents,
  ENQUEUE_QUEUE_KEYS,
} from "../operationEnqueueIntentService.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";
import {
  findPreviewContractRecord,
} from "../../repositories/bulkEditCommandRepository.js";
import {
  buildEditIntentFromRules,
  buildExecutionPlanForEdit,
  isVariantLevelField,
} from "./helpers/bulkEditOperationHelpers.js";

function getPreviewRegistryVersion(fingerprint = {}) {
  return fingerprint?.registryVersion && typeof fingerprint.registryVersion === "object"
    ? fingerprint.registryVersion
    : {};
}

function requireMatchingPreviewValue({ actual, expected, fieldName, code }) {
  if (String(actual || "") !== String(expected || "")) {
    const error = new Error(`${fieldName} mismatch`);
    error.code = code;
    throw error;
  }
}

function buildCodedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class ScheduledEditService {
  constructor({
    session,
    freezeEditHistoryTargets,
  }) {
    this.session = session;
    this.freezeEditHistoryTargets = freezeEditHistoryTargets;
    this.idempotencyStore = new IdempotencyStoreService(db);
  }

  async createScheduledEdit(input = {}) {
    const body = input?.command && typeof input.command === "object"
      ? input.command
      : (input?.body && typeof input.body === "object" ? input.body : {});
    const subscription = input?.subscription || {};
    const actor = input?.actor || null;
    const entitlementSnapshot = input?.entitlementSnapshot || null;
    const idempotencyKey = String(input?.idempotencyKey || "").trim();

    if (!idempotencyKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }

    const begin = await this.idempotencyStore.begin({
      shop: this.session.shop,
      scope: "BULK_EDIT_SCHEDULE",
      key: idempotencyKey,
      requestHash: buildIdempotencyRequestHash({
        shop: this.session.shop,
        operationType: "BULK_EDIT_SCHEDULE",
        command: body,
      }),
    });

    if (begin.mode === "replay") {
      return begin.response;
    }

    try {
    const {
      scheduledAt: rawScheduledAt,
      scheduledUndoAt: rawScheduledUndoAt,
      freezeMode,
      previewContractId,
      previewId,
      previewFilterHash,
      previewMirrorBatchId,
      previewFieldRegistryVersion,
      previewOperatorRegistryVersion,
      approvedTargetCount,
      scheduleConfirmationText,
    } = body;

    const normalizedFreezeMode = String(
      freezeMode || "",
    ).toUpperCase();
    if (normalizedFreezeMode !== "STATIC_AT_SCHEDULE_CREATE") {
      throw new Error("STATIC_SCHEDULE_FREEZE_REQUIRED");
    }

    const resolvedPreviewContractId = String(
      previewContractId || previewId || "",
    ).trim();
    if (!resolvedPreviewContractId) {
      throw new Error("PREVIEW_ID_REQUIRED");
    }

    const previewRecord = await findPreviewContractRecord(
      resolvedPreviewContractId,
      this.session.shop,
    );
    if (!previewRecord) {
      throw new Error("Preview session expired. Please re-preview before scheduling.");
    }
    if (previewRecord.expiresAt && previewRecord.expiresAt < new Date()) {
      throw new Error("PREVIEW_EXPIRED");
    }

    const fingerprint =
      previewRecord.value && typeof previewRecord.value === "object"
        ? previewRecord.value
        : {};
    const previewShop = String(
      previewRecord.shop
      || fingerprint.shop
      || fingerprint.owner?.shop
      || "",
    ).trim();
    const authenticatedShop = String(this.session.shop || "").trim();
    if (!previewShop || previewShop !== authenticatedShop) {
      throw buildCodedError(
        "Run preview again before scheduling this edit.",
        "PREVIEW_NOT_FOUND",
      );
    }

    const registryVersion = getPreviewRegistryVersion(fingerprint);
    const editedField = fingerprint.field;
    const editedBy = fingerprint.editType;
    const value = fingerprint.editValue;
    const searchKey = fingerprint.searchKey || null;
    const replaceText = fingerprint.replaceText || null;
    const supportValue = fingerprint.supportValue ?? null;
    const locationId = fingerprint.locationId || null;
    const operationKey = fingerprint.operationKey || null;
    const filterAst = fingerprint.normalizedAst || null;
    const filterParams = [];
    const confirmDestructive = false;
    const criticalConfirmationText = null;
    const allowNonActiveProducts = false;

    if (!editedField || !editedBy || !filterAst) {
      throw new Error("PREVIEW_SNAPSHOT_INCOMPLETE");
    }

    const previewActorId = String(
      previewRecord.userId
      || fingerprint.actorId
      || fingerprint.owner?.actorId
      || "",
    ).trim();
    const executionActorId = String(actor?.actorId || actor?.userId || "").trim();
    if (previewActorId && executionActorId && previewActorId !== executionActorId) {
      throw buildCodedError(
        "Preview is stale. Run preview again before scheduling this edit.",
        "PREVIEW_STALE",
      );
    }

    requireMatchingPreviewValue({
      actual: previewFilterHash,
      expected: fingerprint.filterHash,
      fieldName: "previewFilterHash",
      code: "PREVIEW_FINGERPRINT_MISMATCH",
    });
    requireMatchingPreviewValue({
      actual: previewMirrorBatchId,
      expected: fingerprint.mirrorBatchId,
      fieldName: "previewMirrorBatchId",
      code: "PREVIEW_FINGERPRINT_MISMATCH",
    });
    requireMatchingPreviewValue({
      actual: previewFieldRegistryVersion,
      expected: registryVersion.fieldRegistryVersion,
      fieldName: "previewFieldRegistryVersion",
      code: "PREVIEW_REGISTRY_VERSION_MISMATCH",
    });
    requireMatchingPreviewValue({
      actual: previewOperatorRegistryVersion,
      expected: registryVersion.operatorRegistryVersion,
      fieldName: "previewOperatorRegistryVersion",
      code: "PREVIEW_REGISTRY_VERSION_MISMATCH",
    });

    const scheduledAt = new Date(rawScheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new Error("Invalid scheduledAt");
    }

    let scheduledUndoAt = null;
    if (rawScheduledUndoAt) {
      const parsedUndoAt = new Date(rawScheduledUndoAt);
      if (Number.isNaN(parsedUndoAt.getTime())) {
        throw new Error("Invalid scheduledUndoAt");
      }
      scheduledUndoAt = parsedUndoAt;
    }

    if (scheduledUndoAt && scheduledUndoAt.getTime() <= scheduledAt.getTime()) {
      throw new Error("Undo time must be later than the scheduled edit time");
    }
    if (editedField === "deleteProducts" && scheduledUndoAt) {
      throw new Error("Undo is not allowed for product deletion");
    }

    const previewTargetCount = Number(
      fingerprint.targetCount ?? previewRecord.previewResCount,
    );
    if (!Number.isFinite(previewTargetCount) || previewTargetCount < 0) {
      throw new Error("PREVIEW_TARGET_COUNT_REQUIRED");
    }
    if (
      approvedTargetCount !== null &&
      approvedTargetCount !== undefined &&
      Number(approvedTargetCount) !== previewTargetCount
    ) {
      throw new Error("APPROVED_TARGET_COUNT_MISMATCH");
    }

    const requiresTypedConfirm = previewTargetCount >= 50 || !scheduledUndoAt;
    if (
      requiresTypedConfirm &&
      String(scheduleConfirmationText || "").trim().toUpperCase() !== "SCHEDULE"
    ) {
      throw new Error("SCHEDULE_CONFIRMATION_REQUIRED");
    }

    const target = await TargetingEngineService.resolvePreviewTargets({
      shop: this.session.shop,
      source: "SCHEDULED",
      targetType: isVariantLevelField(editedField) ? "VARIANT" : "PRODUCT",
      targetGranularity: isVariantLevelField(editedField) ? "VARIANT" : "PRODUCT",
      filterAst: filterAst ?? null,
      legacyFilterParams: Array.isArray(filterParams) ? filterParams : [],
      queryParams: { cursor: null, limit: 20 },
      sampleLimit: 20,
    });
    const count = target.count;
    if (Number(count) !== previewTargetCount) {
      throw new Error("PREVIEW_TARGET_COUNT_MISMATCH");
    }

    const planKey = subscription?.planKey;
    if (!planKey) {
      throw new Error("Subscription not found");
    }
    let scheduledLimit = 0;
    if (planKey === "ADVANCED_MONTHLY") scheduledLimit = 1000;
    else if (planKey === "PRO_MONTHLY") scheduledLimit = Infinity;

    if (scheduledLimit !== Infinity && count > scheduledLimit) {
      throw new Error(
        `Your plan allows scheduling edits for only ${scheduledLimit} products at a time. You selected ${count}. Please refine your filters or upgrade to Pro.`,
      );
    }

    const updatedTitle = getUpdatedProducts({
      field: editedField,
      editType: editedBy,
      value,
      returnTitleOnly: true,
      supportValue,
      searchKey,
      replaceText,
    });
    const multiLanguageTitle = await createMultiLanguage(updatedTitle);
    const undoAllowed = editedField !== "deleteProducts";
    const executionPlan = buildExecutionPlanForEdit({
      operationKey,
      shop: this.session.shop,
      planType: "SCHEDULED_EDIT",
      rules: [{ field: editedField }],
      targetGranularity: target?.targetGranularity || (isVariantLevelField(editedField) ? "VARIANT" : "PRODUCT"),
      targetCount: Number(count || 0),
      shopPlanLimits: { batchSize: 250 },
    });
    const blastRadiusAssessment = computeBlastRadiusRisk({
      targetCount: Number(count || 0),
      totalCatalogCount: Number(target?.broadTargetAssessment?.totalInBatch || 0),
      fieldsEdited: [editedField].filter(Boolean),
      destructiveNature: String(editedField || "") === "deleteProducts",
      undoAvailability: undoAllowed,
      verificationMode: "SAMPLE_PLUS_FAILURES",
    });
    const providedCriticalConfirmation = String(criticalConfirmationText || "").trim();
    if (
      blastRadiusAssessment.riskLevel === "CRITICAL" &&
      providedCriticalConfirmation !== blastRadiusAssessment.requiredCriticalConfirmation
    ) {
      throw new Error(
        `CRITICAL blast radius confirmation required. Type exactly: ${blastRadiusAssessment.requiredCriticalConfirmation}`,
      );
    }
    const delay = scheduledAt.getTime() - Date.now();
    if (delay <= 0) {
      throw new Error("Scheduled time must be in the future");
    }

    const history = await db.editHistory.create({
      data: {
        shop: this.session.shop,
        title: multiLanguageTitle,
        status: "pending",
        statusNormalized: normalizeEditHistoryStatus("pending"),
        executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE,
        executionStateNormalized: normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE),
        executionIdentity: crypto.randomUUID(),
        processedCount: 0,
        totalItems: count,
        targetSnapshotCount: 0,
        targetMirrorBatchId: target.mirrorBatchId || fingerprint.mirrorBatchId || null,
        filterHash: target.filterHash || fingerprint.filterHash || null,
        scheduledAt,
        scheduledUndoAt,
        type: "Scheduled edit",
        queryFilter: JSON.stringify(target.where),
        rules: [
          {
            field: editedField,
            value,
            editOption: editedBy,
            searchKey,
            replaceText,
            supportValue,
            locationId: locationId ?? null,
          },
        ],
        startedAt: new Date(),
        durationMs: 0,
        batch: {
          frozen: normalizedFreezeMode === "STATIC_AT_SCHEDULE_CREATE",
          freezeMode: normalizedFreezeMode,
          hasMore: count > 0,
          lastProductId: null,
          size: 75,
          previewCount: count,
          approvedTargetCount: previewTargetCount,
          currentBatchTargetCount: 0,
          queuedAt: new Date().toISOString(),
          filterParams: [],
          filterAst: target.filterAst ?? filterAst ?? null,
          previewId: resolvedPreviewContractId,
          previewContractId: resolvedPreviewContractId,
          previewFingerprint: {
            previewId: resolvedPreviewContractId,
            filterHash: String(fingerprint.filterHash || ""),
            mirrorBatchId: String(fingerprint.mirrorBatchId || ""),
            fieldRegistryVersion: String(registryVersion.fieldRegistryVersion || ""),
            operatorRegistryVersion: String(registryVersion.operatorRegistryVersion || ""),
            targetCount: previewTargetCount,
          },
          confirmDestructive: confirmDestructive === true,
          criticalConfirmationText: String(criticalConfirmationText || "").trim() || null,
          allowNonActiveProducts: allowNonActiveProducts === true,
          locationId: locationId ?? null,
          targetGranularity:
            target?.targetGranularity ||
            (isVariantLevelField(editedField) ? "VARIANT" : "PRODUCT"),
          executionPlan,
          operationKey: executionPlan.operationKey,
          blastRadiusAssessment,
        },
        undo: buildPlannedUndoState({ allowed: undoAllowed }),
        entitlementSnapshot,
        actorType: actor?.actorType || null,
        actorId: actor?.actorId || null,
        actorEmail: actor?.actorEmail || null,
        actorName: actor?.actorName || null,
      },
    });
    const immutableEditCommand = buildImmutableEditCommand({
      operationType: "BULK_PRODUCT_EDIT",
      shop: history.shop,
      actorUserId: history.actorId || null,
      edit: buildEditIntentFromRules(history.rules),
      targetSnapshotSetId: `EDIT_HISTORY:${history.id}`,
    });
    await db.editHistory.update({
      where: { id: history.id },
      data: {
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          immutableEditCommand,
        },
      },
    });
    if (normalizedFreezeMode === "STATIC_AT_SCHEDULE_CREATE") {
      const freezingStateSet = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop: this.session.shop,
          executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE,
        },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
          ),
        },
      });
      if (freezingStateSet.count !== 1) {
        throw new Error("SCHEDULED_EDIT_STATE_TRANSITION_REJECTED_TARGET_FREEZING");
      }

      const frozenCount = await this.freezeEditHistoryTargets(history.id);
      const frozenStateSet = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop: this.session.shop,
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
        },
        data: {
          totalItems: frozenCount,
          targetSnapshotCount: frozenCount,
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          executionStateNormalized: normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.TARGET_FROZEN),
        },
      });
      if (frozenStateSet.count !== 1) {
        throw new Error("SCHEDULED_EDIT_STATE_TRANSITION_REJECTED_TARGET_FROZEN");
      }
    }

    await createEnqueueIntent({
      shop: this.session.shop,
      queueKey: ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT,
      jobName: "scheduled-task",
      payload: { historyId: history.id, shop: this.session.shop },
      options: {
        delay,
        jobId: scheduledEditRunJobId({
          shop: this.session.shop,
          scheduledEditId: history.id,
          scheduledFor: scheduledAt,
        }),
      },
      dedupeKey: `scheduled-edit:${this.session.shop}:${history.id}:${scheduledAt.toISOString()}`,
    });

    if (scheduledUndoAt && scheduledUndoAt.getTime() > Date.now() && undoAllowed) {
      const undoDelay = scheduledUndoAt.getTime() - Date.now();
      if (undoDelay > 0) {
        await createEnqueueIntent({
          shop: this.session.shop,
          queueKey: ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT,
          jobName: "undo-task",
          payload: { historyId: history.id, shop: this.session.shop },
          options: {
            delay: undoDelay,
            jobId: scheduledEditRunJobId({
              shop: this.session.shop,
              scheduledEditId: `undo:${history.id}`,
              scheduledFor: scheduledUndoAt,
            }),
          },
          dedupeKey: `scheduled-undo:${this.session.shop}:${history.id}:${scheduledUndoAt.toISOString()}`,
        });
      }
    }

    const dispatched = await dispatchPendingEnqueueIntents({
      shop: this.session.shop,
      queueKey: ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT,
      limit: 20,
    });
    if (dispatched.dispatched > 0) {
      const queuedStateSet = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop: this.session.shop,
          OR: [
            { executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE },
            { executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN },
          ],
        },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
          ),
        },
      });
      if (queuedStateSet.count !== 1) {
        throw new Error("SCHEDULED_EDIT_STATE_TRANSITION_REJECTED_SCHEDULED_QUEUED");
      }
    }

      await this.idempotencyStore.complete({
        recordId: begin.recordId,
        response: history,
      });

      return history;
    } catch (error) {
      throw error;
    }
  }
}

