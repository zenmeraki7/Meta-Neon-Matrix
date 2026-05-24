import { errorResponse } from "../utils/responseUtils.js";
import { ProductExportService } from "../services/productService/productExportService.js";
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

export const handleExportProductsData = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session) {
      return res.status(403).json(errorResponse("Session expired"));
    }

    const { filterParams, filterAst, fields, fileName } = req.body;
    const service = new ProductExportService(session);
    const exportJob = await service.createExportJob({
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

    return res.status(200).json({
      message: "Exporting started - queued in background",
      data: exportJob,
    });
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "POST /api/export-products",
    });

    const statusCode = err?.statusCode || 500;
    return res
      .status(statusCode)
      .json({
        ...errorResponse(err.message || "Failed to start export process"),
        code: err?.code || "EXPORT_START_FAILED",
        path: err?.path || null,
        meta: err?.meta || null,
      });
  }
};

export const createProductExport = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    const { fields, fileName, filterParams, filterAst } = req.body;

    if (!session?.shop) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!Array.isArray(fields) || fields.length === 0) {
      return res.status(400).json({ message: "No fields selected" });
    }

    if (!fileName?.trim()) {
      return res.status(400).json({ message: "File name required" });
    }

    const service = new ProductExportService(session);
    const job = await service.createExportJob({
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

    return res.status(200).json({
      exportJobId: job.id,
      status: job.status,
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "POST /api/create-export",
    });

    return res.status(error?.statusCode || 500).json({
      code: error?.code || "EXPORT_CREATE_FAILED",
      path: error?.path || null,
      meta: error?.meta || null,
      message: error.message || "Failed to create export job",
    });
  }
};

export const handleDownloadExportProductsData = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session) {
      return res.status(403).json(errorResponse("Session expired"));
    }

    const service = new ProductExportService(session);
    const result = await service.getExportHistoryDetails(req.params.id);

    if (!result) {
      return res.status(404).json({
        message: "Export history not found",
      });
    }

    if (!result.fileUrl) {
      return res.status(409).json({
        message: "Export file is not ready yet",
      });
    }

    return res.redirect(result.fileUrl);
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "GET /api/export-products/:id/download",
    });

    return res
      .status(500)
      .json(errorResponse("Failed to download export file"));
  }
};

export const cancelExportOperation = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session) {
      return res.status(403).json(errorResponse("Session expired"));
    }
    const result = await requestExportJobCancellation({
      shop: session.shop,
      exportJobId: req.params.id,
      reason: req.body?.cancelReason,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    const statusCode = err?.code === "CANCEL_NOT_ALLOWED_AFTER_EXECUTION" ? 409 : 400;
    return res.status(statusCode).json({
      success: false,
      code: err?.code || "EXPORT_CANCEL_FAILED",
      message: err?.message || "Failed to cancel export operation",
    });
  }
};

export const pauseExportOperation = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session) return res.status(403).json(errorResponse("Session expired"));
    const data = await requestPauseExportOperation({
      shop: session.shop,
      exportJobId: req.params.id,
      subscription: req.subscription || {},
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const statusCode = err?.code === "PREMIUM_FEATURE_REQUIRED" ? 403 : 400;
    return res.status(statusCode).json({ success: false, code: err?.code || "EXPORT_PAUSE_FAILED", message: err.message });
  }
};

export const resumePausedExportOperation = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session) return res.status(403).json(errorResponse("Session expired"));
    const data = await resumeExportOperation({
      shop: session.shop,
      exportJobId: req.params.id,
      subscription: req.subscription || {},
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const statusCode = err?.code === "PREMIUM_FEATURE_REQUIRED" ? 403 : 400;
    return res.status(statusCode).json({ success: false, code: err?.code || "EXPORT_RESUME_FAILED", message: err.message });
  }
};
