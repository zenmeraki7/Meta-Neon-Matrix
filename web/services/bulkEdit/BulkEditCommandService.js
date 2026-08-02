import crypto from "crypto";
import shopify from "../../shopify.js";
import { db } from "../../repositories/repositoryDb.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import logger from "../../utils/loggerUtils.js";
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
} from "../idempotency/IdempotencyStoreService.js";
import { createIdempotencyStore } from "../../repositories/idempotencyRepository.js";
import {
  createManualEditHistoryWithImmutableCommand,
  extendPreviewContractExpiry,
  findExecutablePreviewContractRecord,
  findPreviewContractRecord,
} from "../../repositories/bulkEditCommandRepository.js";
import { upsertAuthoritativeChangeRecord } from "../changeRecordIdentityService.js";
import { consumeUsage } from "../usageLedgerService.js";

const PREVIEW_EXECUTE_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number.parseInt(process.env.PREVIEW_EXECUTE_TTL_MS || "3600000", 10),
);

const DIRECT_EXECUTION_ENABLED =
  process.env.BULK_EDIT_DIRECT_EXECUTION_ENABLED === "true";

const DIRECT_EXECUTION_LIMIT = Math.max(
  0,
  Number.parseInt(process.env.BULK_EDIT_DIRECT_EXECUTION_LIMIT || "100", 10),
);

const DIRECT_VARIANT_BULK_UPDATE_FIELDS = new Set([
  "barcode",
  "compareAtPrice",
  "inventoryPolicy",
  "price",
  "sku",
  "taxable",
]);

const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
        compareAtPrice
        sku
        barcode
        taxable
        inventoryPolicy
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function buildCodedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeShopifyErrorMessage(error) {
  return String(error?.message || error || "Shopify mutation failed")
    .trim()
    .slice(0, 300);
}

function getPreviewFreshUntil(previewRecord) {
  const expiresAtMs = previewRecord?.expiresAt
    ? new Date(previewRecord.expiresAt).getTime()
    : 0;

  const updatedAtMs = previewRecord?.updatedAt
    ? new Date(previewRecord.updatedAt).getTime()
    : 0;

  const createdAtMs = previewRecord?.createdAt
    ? new Date(previewRecord.createdAt).getTime()
    : 0;

  const activityMs = Math.max(updatedAtMs, createdAtMs, 0);

  const activityFreshUntil =
    activityMs > 0 ? activityMs + PREVIEW_EXECUTE_TTL_MS : 0;

  return Math.max(expiresAtMs, activityFreshUntil);
}

function isPreviewContractExpired(previewRecord, now = new Date()) {
  const freshUntil = getPreviewFreshUntil(previewRecord);
  return freshUntil > 0 && freshUntil < now.getTime();
}

function getReadyPreviewRows(fingerprint = {}) {
  const rows = Array.isArray(fingerprint.executableRows)
    ? fingerprint.executableRows
    : Array.isArray(fingerprint.rows)
      ? fingerprint.rows
      : [];

  return rows.filter(
    (row) => String(row?.status || "").toUpperCase() === "READY",
  );
}

function assertExecutablePreviewRows({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw buildCodedError(
      "Preview data is incomplete. Run preview again before applying this edit.",
      "PREVIEW_SNAPSHOT_INCOMPLETE",
    );
  }

  const incomplete = rows.find((row) => {
    const targetResourceType = String(row?.targetResourceType || "").toUpperCase();

    return (
      !row?.productId ||
      !row?.targetIdentity ||
      (targetResourceType === "VARIANT" && !row?.variantId) ||
      row.currentValue === undefined ||
      row.currentValue === null ||
      row.newValue === undefined ||
      row.newValue === null ||
      !row?.plannedMutation?.jsonlRow
    );
  });

  if (incomplete) {
    throw buildCodedError(
      "Preview data is incomplete. Run preview again before applying this edit.",
      "PREVIEW_SNAPSHOT_INCOMPLETE",
    );
  }
}

function getDirectPreviewRowsFromHistoryData(historyData = {}) {
  const rows = Array.isArray(historyData?.batch?.previewRows)
    ? historyData.batch.previewRows
    : [];

  return rows.filter(
    (row) => String(row?.status || "").toUpperCase() === "READY",
  );
}

function shouldExecuteDirectly(historyData = {}) {
  if (!DIRECT_EXECUTION_ENABLED) return false;

  const rows = getDirectPreviewRowsFromHistoryData(historyData);
  const field = String(historyData?.rules?.[0]?.field || "").trim();
  const mode = String(process.env.BULK_EDIT_EXECUTION_MODE || "").toLowerCase();

  const isDirectSupported =
    DIRECT_EXECUTION_LIMIT > 0 &&
    DIRECT_VARIANT_BULK_UPDATE_FIELDS.has(field) &&
    rows.every(
      (row) =>
        String(row?.targetResourceType || "").toUpperCase() === "VARIANT" &&
        String(row?.productId || "").trim() &&
        String(row?.variantId || "").trim(),
    );

  return (
    isDirectSupported &&
    rows.length > 0 &&
    (mode === "direct" || rows.length <= DIRECT_EXECUTION_LIMIT)
  );
}

function normalizeDirectStatus({ successCount, failedCount, totalCount }) {
  if (successCount === totalCount && totalCount > 0) {
    return {
      status: "completed",
      statusNormalized: normalizeEditHistoryStatus("completed"),
      executionState: OPERATION_LIFECYCLE_STATES.COMPLETED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.COMPLETED,
      ),
    };
  }

  if (successCount > 0 && failedCount > 0) {
    return {
      status: "completed_with_errors",
      statusNormalized: normalizeEditHistoryStatus("partial"),
      executionState: OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
      ),
    };
  }

  return {
    status: "failed",
    statusNormalized: normalizeEditHistoryStatus("failed"),
    executionState: OPERATION_LIFECYCLE_STATES.FAILED,
    executionStateNormalized: normalizeEditHistoryExecutionState(
      OPERATION_LIFECYCLE_STATES.FAILED,
    ),
  };
}

function getDirectVariantPayload({ row, field }) {
  const plannedVariant = Array.isArray(row?.plannedMutation?.productSet?.variants)
    ? row.plannedMutation.productSet.variants.find(
        (variant) =>
          String(variant?.id || "").trim() ===
          String(row?.variantId || "").trim(),
      )
    : null;

  const plannedValue =
    plannedVariant && Object.prototype.hasOwnProperty.call(plannedVariant, field)
      ? plannedVariant[field]
      : row?.newValue;

  return {
    id: String(row?.variantId || "").trim(),
    [field]: plannedValue,
  };
}

function assertNoShopifyGraphqlErrors(response) {
  const errors = response?.body?.errors || response?.errors;

  if (Array.isArray(errors) && errors.length > 0) {
    const message = errors[0]?.message || "SHOPIFY_GRAPHQL_ERROR";
    const error = new Error(`SHOPIFY_GRAPHQL_ERROR:${message}`);
    error.retryable = true;
    throw error;
  }
}

export class BulkEditCommandService {
  constructor(session) {
    this.session = session;
    this.idempotencyStore = createIdempotencyStore();
  }

  async createManualBulkEditOperation(input = {}) {
    if (
      input &&
      typeof input === "object" &&
      Object.prototype.hasOwnProperty.call(input, "body")
    ) {
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

    try {
      const actor =
        input.actor ||
        buildActorContext({
          req: { body: command, query: {}, headers: {} },
          session: this.session,
          fallbackType: "MERCHANT_ADMIN",
        });

      const authoritativeSubscription =
        await loadAuthoritativeSubscriptionForShop(this.session.shop);

      const effectiveSubscription = input.subscription || authoritativeSubscription;

      const historyData = await this.#buildManualHistoryData(
        command,
        effectiveSubscription,
        {
          actor,
          entitlementSnapshot: buildEntitlementSnapshot(effectiveSubscription),
        },
      );

      const executionIdentity = command.executionIdentity || crypto.randomUUID();
      const rawCommand = buildImmutableEditCommand({
        operationType: "BULK_PRODUCT_EDIT",
        shop: this.session.shop,
        actorUserId: actor?.id || null,
        edit: buildEditIntentFromRules(historyData.rules),
      });
      const immutableEditCommand = Object.isFrozen(rawCommand)
        ? rawCommand
        : Object.freeze(rawCommand);

      const { historyId, historyShop } =
        await createManualEditHistoryWithImmutableCommand({
          shop: this.session.shop,
          executionIdentity,
          actor: {
            type: actor?.type || "SHOPIFY_USER",
            id: actor?.id || null,
          },
          editType: historyData.editType,
          editedField: historyData.editedField,
          targetCount: historyData.totalItems,
          initialBatch: historyData.batch,
          idempotencyKey: `bulk-edit:${idempotencyKey}`,
          immutableEditCommand,
          usageReservation: {
            units: "TARGET_COUNT",
            quantity: Math.max(1, Number(historyData.totalItems || 0)),
            entitlementKey: "BULK_EDIT_TARGETS",
            idempotencyKey: `bulk-edit:${idempotencyKey}:usage`,
            metadata: {
              expectedBillingAuthorityVersion:
                authoritativeSubscription.billingAuthorityVersion,
              limit: effectiveSubscription?.isUnlimited
                ? null
                : effectiveSubscription?.limit ?? null,
            },
          },
        });


      await clearKeyCaches(`${historyShop}:fetchHistories`);

      if (shouldExecuteDirectly(historyData)) {
        const directResult = await this.#executePreviewRowsDirectly({
          historyId,
          historyShop,
          executionIdentity,
          historyData,
        });
        await consumeUsage({
          shop: historyShop,
          operationType: "BULK_EDIT",
          operationId: historyId,
          entitlementKey: "BULK_EDIT_TARGETS",
          idempotencyKey: `bulk-edit:${historyId}:accepted`,
        });

        await this.idempotencyStore.complete({
          recordId: begin.recordId,
          response: directResult,
        });

        return directResult;
      }

      await enqueueBulkEditTargetFreezeJob({
        historyId,
        shop: historyShop,
        source: "manual_bulk_edit_pipeline",
        executionId: executionIdentity,
      });
      await consumeUsage({
        shop: historyShop,
        operationType: "BULK_EDIT",
        operationId: historyId,
        entitlementKey: "BULK_EDIT_TARGETS",
        idempotencyKey: `bulk-edit:${historyId}:accepted`,
      });

      const response = {
        success: true,
        id: historyId,
        operationId: historyId,
        historyId,
        jobId: historyId,
        status: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
        message: "Bulk edit has been queued.",
      };

      await this.idempotencyStore.complete({
        recordId: begin.recordId,
        response,
      });

      return response;
    } catch (error) {
      if (typeof this.idempotencyStore.fail === "function") {
        await this.idempotencyStore.fail({
          recordId: begin.recordId,
          error: safeShopifyErrorMessage(error),
        }).catch(() => {});
      }

      throw error;
    }
  }

  async createEditHistoryPayload(body, subscription, operationContext = {}) {
    return this.#buildManualHistoryData(body, subscription, operationContext);
  }

  async _bulkOperationEdit(body, subscription, operationContext = {}) {
    return this.#buildManualHistoryData(body, subscription, operationContext);
  }

  async #buildManualHistoryData(body, subscription, operationContext = {}) {
    const locationId = body.locationId ?? body.location ?? null;
    const previewContractId = body.previewContractId ?? body.previewId;

    const {
      editedField,
      previewFilterHash,
      previewMirrorBatchId,
      previewSignature,
      confirmBroadTarget,
      criticalConfirmationText,
      operationKey,
      title: explicitTitle,
    } = body;

    if (!previewContractId) {
      throw new Error("Preview is required before execute. Please run preview again.");
    }

    const previewRecord = await findExecutablePreviewContractRecord({
      previewContractId,
      shop: this.session.shop,
      ...(operationContext?.tx ? { tx: operationContext.tx } : {}),
    });

    if (!previewRecord) {
      throw buildCodedError(
        "Run preview again before applying this edit.",
        "PREVIEW_NOT_FOUND",
      );
    }

    await extendPreviewContractExpiry({
      previewContractId,
      shop: this.session.shop,
      expectedRevision: previewRecord.revision ?? 1,
      expiresAt: new Date(Date.now() + PREVIEW_EXECUTE_TTL_MS),
    }).catch((err) => {
      if (err.code === "PREVIEW_EXPIRY_EXTENSION_CONFLICT") {
        const conflictError = new Error(
          "Preview contract was not found or is no longer extendable",
        );
        conflictError.code = "PREVIEW_EXPIRY_EXTENSION_CONFLICT";
        throw conflictError;
      }
      throw err;
    });

    const fingerprint =
      (previewRecord.filterJson && typeof previewRecord.filterJson === "object"
        ? previewRecord.filterJson
        : previewRecord.value) || {};

    const previewShop = String(
      previewRecord.shop ||
        fingerprint.shop ||
        fingerprint.owner?.shop ||
        "",
    ).trim();

    const authenticatedShop = String(this.session.shop || "").trim();

    if (!previewShop || previewShop !== authenticatedShop) {
      throw buildCodedError(
        "Run preview again before applying this edit.",
        "PREVIEW_NOT_FOUND",
      );
    }

    const resolvedEditedField = editedField ?? fingerprint.field;
    const resolvedEditType = body.editType ?? fingerprint.editType;

    const resolvedEditValue =
      body.editValue !== undefined ? body.editValue : fingerprint.editValue;

    const resolvedSearchKey =
      body.searchKey ?? fingerprint.searchKey ?? null;

    const resolvedReplaceText =
      body.replaceText ?? fingerprint.replaceText ?? null;

    const resolvedSupportValue =
      body.supportValue !== undefined
        ? body.supportValue
        : fingerprint.supportValue;

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
      previewRecord.userId ||
        previewRecord?.value?.actorId ||
        previewRecord?.value?.owner?.actorId ||
        "",
    ).trim();

    const executionActorId = String(
      operationContext.actor?.actorId || "",
    ).trim();

    if (previewActorId && executionActorId && executionActorId !== previewActorId) {
      throw buildCodedError(
        "Preview is stale. Run preview again before applying this edit.",
        "PREVIEW_STALE",
      );
    }

    const expectedHash = String(fingerprint.normalizedFilterHash || "");
    const expectedBatch = String(fingerprint.mirrorBatchId || "");
    const expectedSignature = String(
      fingerprint.previewSignature || "",
    ).trim();

    if (
      (previewFilterHash && String(previewFilterHash || "") !== expectedHash) ||
      (previewMirrorBatchId && String(previewMirrorBatchId || "") !== expectedBatch) ||
      (previewSignature &&
        expectedSignature &&
        String(previewSignature || "").trim() !== expectedSignature)
    ) {
      throw buildCodedError(
        "Preview is stale. Run preview again before applying this edit.",
        "PREVIEW_STALE",
      );
    }

    const targetGranularity =
      String(fingerprint.targetGranularity || "").trim() ||
      resolveTargetGranularityFromRules(rules);

    const previewWhere =
      fingerprint.where && typeof fingerprint.where === "object"
        ? fingerprint.where
        : null;

    const previewCount = Number(fingerprint.count);

    const previewBroadTargetAssessment =
      fingerprint.broadTargetAssessment &&
      typeof fingerprint.broadTargetAssessment === "object"
        ? fingerprint.broadTargetAssessment
        : null;

    const readyPreviewRows = getReadyPreviewRows(fingerprint);

    logger.info("[products-update] preview snapshot", {
      previewId: previewContractId,
      shop: this.session.shop,
      rowsLoaded: Array.isArray(fingerprint.rows) ? fingerprint.rows.length : 0,
      readyRows: readyPreviewRows.length,
      incompleteReason: readyPreviewRows.length ? null : "NO_READY_PREVIEW_ROWS",
    });

    if (readyPreviewRows.length === 0) {
      if (Number.isFinite(previewCount) && previewCount === 0) {
        throw buildCodedError(
          "No matching products were found for this edit. Adjust filters and preview again.",
          "NO_MATCHING_TARGETS",
        );
      }

      throw buildCodedError(
        "Preview data is incomplete. Run preview again before applying this edit.",
        "PREVIEW_SNAPSHOT_INCOMPLETE",
      );
    }

    assertExecutablePreviewRows({
      rows: readyPreviewRows,
    });

    const count = readyPreviewRows.length || previewCount;
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
      legacyQueryFilter: JSON.stringify(
        previewWhere || {
          previewId: previewContractId,
          source: "PERSISTED_PREVIEW_ROWS",
        },
      ),
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
      targetProductMirrorBatchId: expectedBatch,
      editType: "Manual edit",
      durationMs: 0,
      batch: {
        frozen: true,
        hasMore: count > 0,
        lastProductId: null,
        size: 75,
        previewCount: count,
        currentBatchTargetCount: 0,
        queuedAt: new Date().toISOString(),
        rawFilterInput: [],
        filterAst: null,
        previewRows: readyPreviewRows,
        previewId: previewContractId,
        previewContractId,
        previewFingerprint: {
          previewId: previewContractId,
          normalizedFilterHash: expectedHash,
          mirrorBatchId: expectedBatch,
        },
        previewSignature: expectedSignature || null,
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
      actorDisplayName: operationContext.actor?.actorDisplayName || null,
      undo: buildPlannedUndoState({
        allowed: resolvedEditedField !== "deleteProducts",
      }),
    };
  }

  async #executePreviewRowsDirectly({
    historyId,
    historyShop,
    executionIdentity,
    historyData,
  }) {
    const rows = getDirectPreviewRowsFromHistoryData(historyData);
    const startedAt = new Date();
    const batchId = `direct:${historyId}`;
    const field = String(historyData?.rules?.[0]?.field || "").trim();

    logger.info("[bulk-edit-execute] start", {
      historyId,
      shop: historyShop,
      loadedItems: rows.length,
      executionMode: "direct",
    });

    if (!this.session?.accessToken) {
      throw buildCodedError("Unable to start edit job.", "EDIT_START_FAILED");
    }

    const client = new shopify.api.clients.Graphql({ session: this.session });

    await db.changeRecord.deleteMany({
      where: {
        shop: historyShop,
        editHistoryId: historyId,
        batchId,
      },
    });

    await db.editHistory.updateMany({
      where: { id: historyId, shop: historyShop },
      data: {
        status: "processing",
        statusNormalized: normalizeEditHistoryStatus("processing"),
        executionState: OPERATION_LIFECYCLE_STATES.EXECUTING,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.EXECUTING,
        ),
        startedAt,
        totalItems: rows.length,
        targetSnapshotCount: rows.length,
        processedCount: 0,
        editType: "Manual edit",
        batch: {
          ...(historyData.batch && typeof historyData.batch === "object"
            ? historyData.batch
            : {}),
          executionMode: "direct",
          currentBatchTargetCount: rows.length,
          ingestionSummary: {
            totalTargets: rows.length,
            submittedCount: 0,
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
          },
        },
      },
    });

    let successCount = 0;
    let failedCount = 0;

    for (const row of rows) {
      const variantId = String(row?.variantId || "").trim();
      const newValue = row?.newValue;
      let status = "failed";
      let failureMessage = null;
      let failureCode = null;
      let afterValues = { [field]: newValue };

      try {
        const variantInput = getDirectVariantPayload({ row, field });

        // eslint-disable-next-line no-await-in-loop
        const result = await client.query({
          data: {
            query: PRODUCT_VARIANTS_BULK_UPDATE_MUTATION,
            variables: {
              productId: String(row?.productId || "").trim(),
              variants: [variantInput],
            },
          },
        });

        assertNoShopifyGraphqlErrors(result);

        const payload =
          result?.body?.data?.productVariantsBulkUpdate ||
          result?.data?.productVariantsBulkUpdate ||
          null;

        const userErrors = Array.isArray(payload?.userErrors)
          ? payload.userErrors
          : [];

        if (userErrors.length) {
          const error = new Error(
            userErrors.map((item) => item?.message).filter(Boolean).join("; "),
          );
          error.nonRetryable = true;
          throw error;
        }

        const updatedVariant = Array.isArray(payload?.productVariants)
          ? payload.productVariants.find(
              (variant) => String(variant?.id || "").trim() === variantId,
            )
          : null;

        afterValues = {
          [field]: updatedVariant?.[field] ?? variantInput[field] ?? newValue,
        };

        status = "succeeded";
        successCount += 1;

        logger.info("[bulk-edit-execute] variant update success", {
          historyId,
          variantId,
        });
      } catch (error) {
        failureMessage = safeShopifyErrorMessage(error);
        failureCode = error?.retryable
          ? "SHOPIFY_RETRYABLE_ERROR"
          : "SHOPIFY_USER_ERROR";
        failedCount += 1;

        logger.warn("[bulk-edit-execute] variant update failed", {
          historyId,
          variantId,
          code: failureCode,
        });
      }

      // eslint-disable-next-line no-await-in-loop
      await upsertAuthoritativeChangeRecord({
        tx: db,
        data: {
          editHistoryId: historyId,
          targetResourceType: "VARIANT",
          targetIdentity: variantId,
          fieldPath: String(row?.fieldPath || `variant.${field}`),
          productId: String(row?.productId || ""),
          variantId,
          shop: historyShop,
          mirrorBatchId: historyData.targetProductMirrorBatchId || null,
          beforeValues: row?.beforeValues || {
            [field]: row?.currentValue ?? null,
          },
          afterValues,
          failureCode,
          failureMessage,
          options: {
            productTitle: row?.productTitle || null,
            variantTitle: row?.variantTitle || null,
          },
          productFieldChanges: [],
          variantFieldChanges: [
            {
              variantId,
              variantTitle: row?.variantTitle || "Default Title",
              changes: [
                {
                  field,
                  oldValue: row?.currentValue ?? null,
                  newValue,
                },
              ],
            },
          ],
          title: row?.productTitle || "Untitled product",
          changeScope: "variant",
          status,
          batchId,
        },
      });
    }

    const totalCount = rows.length;
    const skippedCount = 0;
    const processedCount = successCount + failedCount + skippedCount;

    const finalState = normalizeDirectStatus({
      successCount,
      failedCount,
      totalCount,
    });

    const completedAt = new Date();

    await db.editHistory.updateMany({
      where: { id: historyId, shop: historyShop },
      data: {
        status: finalState.status,
        statusNormalized: finalState.statusNormalized,
        executionState: finalState.executionState,
        executionStateNormalized: finalState.executionStateNormalized,
        processedCount,
        totalItems: totalCount,
        targetSnapshotCount: totalCount,
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        editType: "Manual edit",
        batch: {
          ...(historyData.batch && typeof historyData.batch === "object"
            ? historyData.batch
            : {}),
          executionMode: "direct",
          currentBatchTargetCount: totalCount,
          ingestionSummary: {
            totalTargets: totalCount,
            submittedCount: processedCount,
            successCount,
            failedCount,
            skippedCount,
          },
          verificationStatus: failedCount > 0 ? "FAILED" : "PASSED",
          verifiedCount: successCount,
        },
      },
    });

    await clearKeyCaches(`${historyShop}:fetchHistories`);

    logger.info("[bulk-edit-execute] finalized", {
      historyId,
      status: finalState.status,
      success: successCount,
      failed: failedCount,
    });

    return {
      success: true,
      id: historyId,
      operationId: historyId,
      historyId,
      jobId: historyId,
      status: finalState.status,
      matchingProductCount: totalCount,
      affectedVariantCount: totalCount,
      successCount,
      failedCount,
      skippedCount,
      historyUrl: `/editDetails/${historyId}`,
      executionId: executionIdentity || null,
      message: "Bulk edit completed.",
    };
  }
}
