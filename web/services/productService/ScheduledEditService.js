import crypto from "crypto";
import { prisma } from "../../config/database.js";
import { createMultiLanguage } from "../../utils/googleTranslator.js";
import { scheduledEditQueue } from "../../Jobs/Queues/scheduledEditQueue.js";
import { joinSafeJobId } from "../../utils/jobQueueUtils.js";
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
  buildEditIntentFromRules,
  buildExecutionPlanForEdit,
  isVariantLevelField,
} from "./helpers/bulkEditOperationHelpers.js";

export class ScheduledEditService {
  constructor({
    session,
    freezeEditHistoryTargets,
  }) {
    this.session = session;
    this.freezeEditHistoryTargets = freezeEditHistoryTargets;
  }

  async createScheduledEdit({
    body = {},
    subscription = {},
    actor = null,
    entitlementSnapshot = null,
  }) {
    const {
      editedField,
      editedBy,
      filterParams,
      filterAst,
      value,
      scheduledAt: rawScheduledAt,
      scheduledUndoAt: rawScheduledUndoAt,
      searchKey,
      replaceText,
      supportValue,
      locationId,
      operationKey = null,
      confirmDestructive = false,
      criticalConfirmationText = null,
      allowNonActiveProducts = false,
      freezeMode = "DYNAMIC_AT_RUN",
    } = body;

    const normalizedFreezeMode = String(
      freezeMode || "DYNAMIC_AT_RUN",
    ).toUpperCase();
    if (
      !["DYNAMIC_AT_RUN", "STATIC_AT_SCHEDULE_CREATE"].includes(
        normalizedFreezeMode,
      )
    ) {
      throw new Error("Invalid freezeMode");
    }
    const hasLegacyFilters =
      Array.isArray(filterParams) && filterParams.length > 0;
    const hasFilterAst =
      filterAst &&
      typeof filterAst === "object";

    if (!editedField || (!hasLegacyFilters && !hasFilterAst)) {
      throw new Error("Missing required edit field or target filter");
    }

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

    const history = await prisma.editHistory.create({
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
        targetMirrorBatchId: null,
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
          currentBatchTargetCount: 0,
          queuedAt: new Date().toISOString(),
          filterParams: [],
          filterAst: target.filterAst ?? filterAst ?? null,
          confirmDestructive: confirmDestructive === true,
          criticalConfirmationText: String(criticalConfirmationText || "").trim() || null,
          allowNonActiveProducts: allowNonActiveProducts === true,
          locationId: locationId ?? null,
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
    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          immutableEditCommand,
        },
      },
    });
    if (normalizedFreezeMode === "STATIC_AT_SCHEDULE_CREATE") {
      const frozenCount = await this.freezeEditHistoryTargets(history.id);
      await prisma.editHistory.update({
        where: { id: history.id },
        data: {
          totalItems: frozenCount,
          targetSnapshotCount: frozenCount,
          executionStateNormalized: normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.TARGET_FROZEN),
        },
      });
    }

    await scheduledEditQueue.add(
      "scheduled-task",
      { historyId: history.id, shop: this.session.shop },
      { delay, jobId: joinSafeJobId("scheduled-edit", this.session.shop, history.id) },
    );
    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        ),
      },
    });

    if (scheduledUndoAt && scheduledUndoAt.getTime() > Date.now() && undoAllowed) {
      const undoDelay = scheduledUndoAt.getTime() - Date.now();
      if (undoDelay > 0) {
        await scheduledEditQueue.add(
          "undo-task",
          { historyId: history.id, shop: this.session.shop },
          { delay: undoDelay, jobId: joinSafeJobId("scheduled-undo", this.session.shop, history.id) },
        );
      }
    }

    return history;
  }
}
