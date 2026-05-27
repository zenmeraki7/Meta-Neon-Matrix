import { ProductExportCommandService } from "../services/productExport/ProductExportCommandService.js";
import { logApiError } from "../utils/errorLogUtils.js";
import {
  buildActorContext,
  buildEntitlementSnapshot,
} from "../utils/operationContextUtils.js";
import { requestExportJobCancellation } from "../services/operationCancellationService.js";
import {
  requestPauseExportOperation,
  resumeExportOperation,
} from "../services/operationPauseResumeService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function toExportJobDto(exportJob) {
  return {
    success: true,
    exportJobId: exportJob.id,
    status: "QUEUED",
    queuedAt: exportJob.createdAt,
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

export const createProductExport = async (req, res) => {
  let session;

  try {
    session = getSessionOrThrow(res);
    const { fields, fileName, filterParams, filterAst } = req.body;

    if (!Array.isArray(fields) || fields.length === 0) {
      const error = new Error("FIELDS_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    if (!fileName?.trim()) {
      const error = new Error("FILE_NAME_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    const commandService = new ProductExportCommandService(session);
    const job = await commandService.createExportCommand({
      fields,
      fileName,
      filterParams,
      filterAst,
      actor: buildActorContext({
        req,
        session,
        fallbackType: "MERCHANT_ADMIN",
      }),
      entitlementSnapshot: buildEntitlementSnapshot(req.subscription),
    });

    return res.status(200).json(toExportJobDto(job));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "POST /api/create-export",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const handleDownloadExportProductsData = async (req, res) => {
  let session;

  try {
    session = getSessionOrThrow(res);

    const commandService = new ProductExportCommandService(session);
    const result = await commandService.getExportDetails(req.params.id);

    if (!result) {
      const error = new Error("EXPORT_HISTORY_NOT_FOUND");
      error.code = "NOT_FOUND";
      throw error;
    }

    if (!result.fileUrl) {
      const error = new Error("EXPORT_FILE_NOT_READY");
      error.code = "CONFLICT";
      throw error;
    }

    return res.redirect(result.fileUrl);
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "GET /api/export-products/:id/download",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const cancelExportOperation = async (req, res) => {
  let session;
  try {
    session = getSessionOrThrow(res);
    const result = await requestExportJobCancellation({
      shop: session.shop,
      exportJobId: req.params.id,
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

export const pauseExportOperation = async (req, res) => {
  let session;
  try {
    session = getSessionOrThrow(res);
    const data = await requestPauseExportOperation({
      shop: session.shop,
      exportJobId: req.params.id,
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

export const resumePausedExportOperation = async (req, res) => {
  let session;
  try {
    session = getSessionOrThrow(res);
    const data = await resumeExportOperation({
      shop: session.shop,
      exportJobId: req.params.id,
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
