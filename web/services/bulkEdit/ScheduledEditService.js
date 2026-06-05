import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { scheduledEditRunJobId } from "../../utils/jobQueueUtils.js";
import { buildPlannedUndoState } from "../bulkEditExecutionStateService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import { computeBlastRadiusRisk } from "../targeting/validate/mutationIntentPreflightValidator.js";
import { buildImmutableEditCommand } from "./immutableEditCommand.js";
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
  buildEditIntentFromRules,
  buildHistoryTitle,
  isVariantLevelField,
  normalizeField,
} from "./bulkEditRuleUtils.js";
import { buildExecutionPlanForEdit } from "./bulkEditPlanUtils.js";

export class ScheduledEditService {
  constructor({
    session,
    freezeEditHistoryTargets,
  } = {}) {
    if (!session?.shop) {
      throw new Error("SCHEDULED_EDIT_REQUIRES_SHOP_SESSION");
    }
    if (typeof freezeEditHistoryTargets !== "function") {
      throw new Error("SCHEDULED_EDIT_REQUIRES_TARGET_FREEZE_DEPENDENCY");
    }

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

    if (!this.session?.shop) {
      throw new Error("SCHEDULED_EDIT_REQUIRES_SHOP_SESSION");
    }
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

    const normalizedFreezeMode = String(freezeMode || "DYNAMIC_AT_RUN").toUpperCase();
    if (!["DYNAMIC_AT_RUN", "STATIC_AT_SCHEDULE_CREATE"].includes(normalizedFreezeMode)) {
      throw new Error("Invalid freezeMode");
    }
    const hasLegacyFilters = Array.isArray(filterParams) && filterParams.length > 0;
    const hasFilterAst = filterAst && typeof filterAst === "object";

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

    const normalizedEditedField = normalizeField(editedField);

    if (normalizedEditedField === "deleteProducts" && scheduledUndoAt) {
      throw new Error("Undo is not allowed for product deletion");
    }

    const targetGranularity = isVariantLevelField(normalizedEditedField) ? "VARIANT" : "PRODUCT";
    const target = await TargetingEngineService.resolvePreviewTargets({
      shop: this.session.shop,
      source: "SCHEDULED",
      targetType: targetGranularity,
      targetGranularity,
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
      throw new Error(`Your plan allows scheduling edits for only ${scheduledLimit} products at a time. You selected ${count}. Please refine your filters or upgrade to Pro.`);
    }

    const scheduledRule = {
      field: normalizedEditedField,
      editOption: editedBy,
      value,
      searchKey,
      replaceText,
      supportValue,
      locationId: locationId ?? null,
    };
    const title = buildHistoryTitle([scheduledRule]);
    const undoAllowed = normalizedEditedField !== "deleteProducts";
    const executionPlan = buildExecutionPlanForEdit({
      operationKey,
      shop: this.session.shop,
      planType: "SCHEDULED_EDIT",
      rules: [scheduledRule],
      targetGranularity: target?.targetGranularity || targetGranularity,
      targetCount: Number(count || 0),
      shopPlanLimits: { batchSize: 250 },
    });
    const blastRadiusAssessment = computeBlastRadiusRisk({
      targetCount: Number(count || 0),
      totalCatalogCount: Number(target?.broadTargetAssessment?.totalInBatch || 0),
      fieldsEdited: [normalizedEditedField].filter(Boolean),
      destructiveNature: String(normalizedEditedField || "") === "deleteProducts",
      undoAvailability: undoAllowed,
      verificationMode: "SAMPLE_PLUS_FAILURES",
    });
    const providedCriticalConfirmation = String(criticalConfirmationText || "").trim();
    if (
      blastRadiusAssessment.riskLevel === "CRITICAL"
      && providedCriticalConfirmation !== blastRadiusAssessment.requiredCriticalConfirmation
    ) {
      throw new Error(`CRITICAL blast radius confirmation required. Type exactly: ${blastRadiusAssessment.requiredCriticalConfirmation}`);
    }
    const delay = scheduledAt.getTime() - Date.now();
    if (delay <= 0) {
      throw new Error("Scheduled time must be in the future");
    }

    const history = await db.editHistory.create({
      data: {
        shop: this.session.shop,
        title,
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
        rules: [scheduledRule],
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
    const commandAttached = await db.editHistory.updateMany({
      where: { id: history.id, shop: this.session.shop },
      data: {
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          immutableEditCommand,
        },
      },
    });
    if (Number(commandAttached?.count || 0) !== 1) {
      throw new Error("SCHEDULED_EDIT_COMMAND_ATTACH_CONFLICT");
    }
    if (normalizedFreezeMode === "STATIC_AT_SCHEDULE_CREATE") {
      const frozenCount = await this.freezeEditHistoryTargets(history.id, { shop: this.session.shop });
      const frozenStateSet = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop: this.session.shop,
          executionState: OPERATION_LIFECYCLE_STATES.SCHEDULED_PENDING_QUEUE,
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
      shop: this.session.shop,
      response: history,
    });

    return history;
  }
}
