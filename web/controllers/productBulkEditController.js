import UndoEditService from "../services/productService/productBulkUndoService.js";
import ProductBulkService from "../services/productService/productBulkEditService.js";
import { errorResponse } from "../utils/responseUtils.js";
import { clearAllCachesForShop } from "../utils/cacheUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import {
  buildActorContext,
  buildEntitlementSnapshot,
} from "../utils/operationContextUtils.js";
import { requestEditHistoryCancellation } from "../services/operationCancellationService.js";
import {
  requestPauseEditOperation,
  resumeEditOperation,
} from "../services/operationPauseResumeService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { getTargetingVersionBundle } from "../services/targeting/versioning.js";

function normalizeBulkEditExecuteBody(body = {}, query = {}) {
  return {
    editedField: body.editedField ?? body.field ?? null,
    editType: body.editType ?? body.editedType ?? null,
    editValue: body.editValue ?? body.value ?? null,
    searchKey: body.searchKey ?? null,
    replaceText: body.replaceText ?? null,
    supportValue: body.supportValue ?? null,
    locationId: body.locationId ?? body.location ?? null,
    filterParams: Array.isArray(body.filterParams) ? body.filterParams : [],
    filterAst: body.filterAst ?? null,
    previewId: body.previewId ?? null,
    previewFilterHash: body.previewFilterHash ?? body.previewFingerprint?.filterHash ?? null,
    previewMirrorBatchId:
      body.previewMirrorBatchId ?? body.previewFingerprint?.mirrorBatchId ?? null,
    previewFieldRegistryVersion:
      body.previewFieldRegistryVersion ??
      body.previewFingerprint?.fieldRegistryVersion ??
      null,
    previewOperatorRegistryVersion:
      body.previewOperatorRegistryVersion ??
      body.previewFingerprint?.operatorRegistryVersion ??
      null,
    confirmBroadTarget: body.confirmBroadTarget === true,
    criticalConfirmationText: body.criticalConfirmationText ?? null,
    operationKey: body.operationKey ?? null,
    productIds: Array.isArray(body.productIds) ? body.productIds : [],
    title: body.title ?? null,
    cursor: body.cursor ?? query.cursor ?? null,
    limit: body.limit ?? query.limit ?? null,
  };
}

function toScheduledEditDto(history) {
  return {
    scheduledOperationId: history.id,
    status: history.executionState,
    scheduledAt: history.scheduledAt,
    scheduledUndoAt: history.scheduledUndoAt ?? null,
  };
}

function getSessionOrThrow(res) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  return session;
}

function assertExecutePreviewFingerprint(command = {}) {
  if (!command.previewId) {
    const error = new Error("PREVIEW_ID_REQUIRED");
    error.code = "VALIDATION_FAILED";
    throw error;
  }
  if (!command.previewFilterHash) {
    const error = new Error("PREVIEW_FINGERPRINT_REQUIRED");
    error.code = "VALIDATION_FAILED";
    throw error;
  }
  if (!command.previewFieldRegistryVersion || !command.previewOperatorRegistryVersion) {
    const error = new Error("PREVIEW_REGISTRY_VERSION_REQUIRED");
    error.code = "VALIDATION_FAILED";
    throw error;
  }
}

function assertPreviewRegistryVersionMatches(command = {}) {
  const current = getTargetingVersionBundle();
  const fieldMatch =
    String(command.previewFieldRegistryVersion || "") ===
    String(current.fieldRegistryVersion || "");
  const operatorMatch =
    String(command.previewOperatorRegistryVersion || "") ===
    String(current.operatorRegistryVersion || "");

  if (!fieldMatch || !operatorMatch) {
    const error = new Error("PREVIEW_REGISTRY_VERSION_MISMATCH");
    error.code = "PREVIEW_REGISTRY_VERSION_MISMATCH";
    throw error;
  }
}

function normalizeScheduledEditBody(body = {}) {
  return {
    ...body,
    scheduledAt: body?.scheduledAt ?? null,
    scheduledUndoAt: body?.scheduledUndoAt ?? null,
    freezeMode: body?.freezeMode ?? null,
  };
}

function assertValidFreezeMode(freezeMode) {
  const allowed = new Set(["STATIC_AT_SCHEDULE_CREATE", "DYNAMIC_AT_RUN"]);
  if (!freezeMode || !allowed.has(String(freezeMode))) {
    const error = new Error("INVALID_FREEZE_MODE");
    error.code = "VALIDATION_FAILED";
    throw error;
  }
}

function toPreviewDto(result) {
  const preview = result?.data || {};
  const fingerprint = preview?.previewFingerprint || {};
  const risk = result?.risk || {};
  const normalizedPreviewRows = Array.isArray(preview.preview) ? preview.preview : [];
  const normalizedPagination = preview?.pagination && typeof preview.pagination === "object"
    ? preview.pagination
    : null;
  const normalizedIsVariant =
    String(preview.targetGranularity || "PRODUCT").toUpperCase() === "VARIANT";
  const normalizedFingerprint = {
    filterHash: fingerprint.filterHash || null,
    mirrorBatchId: fingerprint.mirrorBatchId || null,
    compilerVersion: fingerprint.compilerVersion || null,
    fieldRegistryVersion: fingerprint.registryVersion?.fieldRegistryVersion || null,
    operatorRegistryVersion: fingerprint.registryVersion?.operatorRegistryVersion || null,
  };
  return {
    success: true,
    count: Number(preview.targetCount || 0),
    productCount: Number(preview.productCount || 0),
    variantCount: Number(preview.variantCount || 0),
    targetGranularity: String(preview.targetGranularity || "PRODUCT").toUpperCase(),
    previewFingerprint: normalizedFingerprint,
    risk: {
      riskLevel: risk.riskLevel || "NORMAL",
      riskScore: Number(risk.riskScore || 0),
      requiredCriticalConfirmation: risk.requiredCriticalConfirmation || null,
    },
    data: {
      preview: normalizedPreviewRows,
      pagination: normalizedPagination,
      isVariant: normalizedIsVariant,
      previewFingerprint: normalizedFingerprint,
      requiresConfirmation: Boolean(result?.broadTargetAssessment?.requiresConfirmation),
    },
  };
}

export const undoEdit = async (req, res) => {
  let session;
  const { id } = req.params;

  try {
    session = getSessionOrThrow(res);
    const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
    if (!idempotencyKey) {
      const err = new Error("IDEMPOTENCY_KEY_REQUIRED");
      err.code = "VALIDATION_FAILED";
      throw err;
    }

    const service = new UndoEditService(session);
    const result = await service.undoEdit(id, { idempotencyKey });

    return res.status(202).json({
      success: true,
      undoOperationId: result?.data?.id || id,
      status: "QUEUED",
      message: result?.message || "Undo processing started",
    });
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "POST /api/undo-edit/:id",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const handleBulkEditProduct = async (req, res) => {
  let session;

  try {
    session = getSessionOrThrow(res);

    const command = normalizeBulkEditExecuteBody(req.body, req.query);
    assertExecutePreviewFingerprint(command);
    assertPreviewRegistryVersionMatches(command);
    const actor = buildActorContext({
      req,
      session,
      fallbackType: "MERCHANT_ADMIN",
    });

    const service = new ProductBulkService(session);
    const result = await service.bulkEditProducts({
      shop: session.shop,
      actor,
      subscription: req.subscription,
      command,
      idempotencyKey: req.headers["idempotency-key"],
    });

    if (!result) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "INTERNAL_ERROR" },
        "INTERNAL_ERROR",
      );
      return res.status(statusCode).json(body);
    }

    await clearAllCachesForShop(session.shop);

    return res.status(202).json({
      success: true,
      operationId: result.operationId || result.id,
      status: result.status || "TARGET_FREEZING",
      message: result.message || "Bulk edit has been queued.",
    });
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "POST /api/bulk-edit",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const trackEditPreview = async (req, res) => {
  let session;

  try {
    session = getSessionOrThrow(res);

    const command = normalizeBulkEditExecuteBody(req.body, req.query);
    const lang = req.query.lang || "en";

    const service = new ProductBulkService(session);
    const actor = buildActorContext({
      req,
      session,
      fallbackType: "MERCHANT_ADMIN",
    });

    const result = await service.trackEditProducts({
      field: command.editedField,
      editType: command.editType,
      editValue: command.editValue,
      filterParams: command.filterParams,
      filterAst: command.filterAst,
      searchKey: command.searchKey,
      replaceText: command.replaceText,
      supportValue: command.supportValue,
      operationKey: command.operationKey,
      lang,
      cursor: command.cursor,
      limit: command.limit,
      subscription: req.subscription,
      actorId: actor.actorId || null,
    });
    return res.status(200).json(toPreviewDto(result));
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "POST /api/edit-preview",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const createScheduledEdit = async (req, res) => {
  let session;

  try {
    session = getSessionOrThrow(res);
    const bulkService = new ProductBulkService(session);

    const command = normalizeScheduledEditBody(req.body);
    assertValidFreezeMode(command.freezeMode);

    const history = await bulkService.createScheduledEdit({
      body: command,
      subscription: req.subscription,
      actor: buildActorContext({
        req,
        session,
        fallbackType: "SCHEDULE",
      }),
      entitlementSnapshot: buildEntitlementSnapshot(req.subscription),
    });

    return res.status(202).json({
      success: true,
      ...toScheduledEditDto(history),
    });
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "POST /api/scheduled-edit",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const cancelEditOperation = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }
    const result = await requestEditHistoryCancellation({
      shop: session.shop,
      historyId: req.params.id,
      reason: req.body?.cancelReason,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const pauseEditOperation = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }
    const data = await requestPauseEditOperation({
      shop: session.shop,
      historyId: req.params.id,
      subscription: req.subscription || {},
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const resumePausedEditOperation = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }
    const data = await resumeEditOperation({
      shop: session.shop,
      historyId: req.params.id,
      subscription: req.subscription || {},
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const retryFailedOnlyEditOperation = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }
    const service = new ProductBulkService(session);
    const data = await service.retryFailedOnly({ historyId: req.params.id });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};
