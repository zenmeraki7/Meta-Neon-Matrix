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

export const undoEdit = async (req, res) => {
  const session = res.locals.shopify?.session;
  const { id } = req.params;

  try {
    if (!session) {
      return res.status(403).json(errorResponse("Session expired"));
    }

    const { status } = await getCurrentBulkOperationStatus(session);

    if (status === "RUNNING") {
      return res
        .status(400)
        .json({ message: "Another operation is running in background" });
    }

    const service = new UndoEditService(session);
    const result = await service.undoEdit(id);

    return res.status(200).json(result.data);
  } catch (err) {
    console.error(err.message);
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "POST /api/undo-edit/:id",
    });

    return res.status(500).json(errorResponse("Failed to undo edit"));
  }
};

export const handleBulkEditProduct = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session) {
      return res.status(403).json(errorResponse("Session expired"));
    }

    const service = new ProductBulkService(session);
    const result = await service.bulkEditProducts({
      ...req,
      subscription: req.subscription,
    });

    if (!result) {
      return res.status(500).json({
        message: "Bulk edit failed â€” no result returned.",
      });
    }

    await clearAllCachesForShop(session.shop);

    return res.status(202).json(result);
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
  const session = res.locals.shopify?.session;

  try {
    if (!session) {
      return res.status(403).json(errorResponse("Session expired"));
    }

    const {
      field,
      editType,
      editValue,
      searchKey,
      replaceText,
      filterParams,
      filterAst,
      supportValue,
      operationKey,
      cursor,
      limit,
    } = req.body;

    const lang = req.query.lang || "en";
    // console.log("🔴 BACKEND RECEIVED FIELD:", req.body.field);
    // console.log("🔴 EDIT TYPE:", req.body.editType);
    if (process.env.NODE_ENV === "production") {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.filterTrack.create({
        data: {
          shop: session.shop,
          previewFilterParams: filterParams,
          type: "preview",
          field,
          editOption: editType,
          value: editValue,
          en: lang,
          searchKey,
          replaceText,
          supportValue,
          source: "edit_preview",
          expiresAt,
        },
      });
    }

    const service = new ProductBulkService(session);
    const actor = buildActorContext({
      req,
      session,
      fallbackType: "MERCHANT_ADMIN",
    });

    const result = await service.trackEditProducts({
      field,
      editType,
      editValue,
      filterParams,
      filterAst,
      searchKey,
      replaceText,
      supportValue,
      operationKey,
      lang,
      cursor,
      limit,
      subscription: req.subscription,
      actorId: actor.actorId || null,
    });
    // console.log("🔴 BACKEND RESPONSE:", result);
    return res.status(200).json(result);
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "POST /api/edit-preview",
    });

    return res.status(500).json(errorResponse("Failed to track edit preview"));
  }
};

export const createScheduledEdit = async (req, res) => {
  const session = res.locals.shopify?.session;
  const bulkService = session ? new ProductBulkService(session) : null;

  try {
    if (!session) {
      return res.status(403).json({ error: "Session expired" });
    }

    const history = await bulkService.createScheduledEdit({
      body: req.body,
      subscription: req.subscription,
      actor: buildActorContext({
        req,
        session,
        fallbackType: "SCHEDULE",
      }),
      entitlementSnapshot: buildEntitlementSnapshot(req.subscription),
    });

    return res.status(201).json({
      message: "Scheduled successfully",
      history,
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
      return res.status(403).json(errorResponse("Session expired"));
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
    if (!session) return res.status(403).json(errorResponse("Session expired"));
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
    if (!session) return res.status(403).json(errorResponse("Session expired"));
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
    if (!session) return res.status(403).json(errorResponse("Session expired"));
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
