import { requireShopifySession } from "../http/shopifySession.js";
import { buildActorFromSession } from "../http/actorContext.js";
import { setPrivateNoStore } from "../http/cacheHeaders.js";
import {
  buildCreateProductExportCommand,
  buildDownloadProductExportCommand,
  buildCancelExportCommand,
  buildPauseExportCommand,
  buildResumeExportCommand,
} from "../normalizers/productExportCommandNormalizer.js";
import {
  toExportJobQueuedResponseDto,
  toExportCancellationResponseDto,
  toExportPauseResponseDto,
  toExportResumeResponseDto,
} from "../dtos/productExportDto.js";
import {
  productExportUseCases,
  productExportLifecycleUseCases,
} from "../useCases/productExportUseCases.js";
import { listExportFields } from "../services/productService/productExportFieldRegistry.js";
import {
  ExportDownloadError,
  logExportDownloadFailure,
  streamExportCsvDownload,
} from "../services/productExport/exportDownloadService.js";

function buildContext(req, session) {
  return Object.freeze({
    shop: session.shop,
    actor: buildActorFromSession(session),
    subscription: req.subscription || null,
    entitlement: req.entitlement || null,
    activePlan: req.activePlan || {},
  });
}

function buildHeaders(req) {
  return Object.freeze({
    idempotencyKey: req.get("Idempotency-Key") || null,
  });
}

function sendDownloadError(res, error) {
  const statusCode = Number(error?.statusCode || 500);
  const safeStatus = statusCode === 499 ? 499 : Math.min(Math.max(statusCode, 400), 599);
  const code = String(error?.code || "EXPORT_DOWNLOAD_FAILED");
  const messageByCode = {
    VALIDATION_FAILED: "Invalid export id.",
    UNAUTHENTICATED: "Authentication required.",
    EXPORT_NOT_FOUND: "This export is no longer available.",
    EXPORT_NOT_READY: "The export file is not available yet.",
    EXPORT_FILE_REFERENCE_MISSING: "The export file is not available yet.",
    EXPORT_FILE_REFERENCE_INVALID: "The export file could not be retrieved. Please try again.",
    EXPORT_FILE_REFERENCE_UNSAFE: "The export file could not be retrieved. Please try again.",
    EXPORT_FILE_BODY_MISSING: "The export file could not be retrieved. Please try again.",
    EXPORT_FILE_UPSTREAM_UNAVAILABLE: "The export file could not be retrieved. Please try again.",
    EXPORT_FILE_TIMEOUT: "The export file retrieval timed out. Please try again.",
    EXPORT_DOWNLOAD_ABORTED: "The export download was cancelled.",
  };

  return res.status(safeStatus).json({
    ok: false,
    success: false,
    code,
    message: messageByCode[code] || "The export file could not be retrieved. Please try again.",
  });
}

export const createProductExport = async (req, res, next) => {
  try {
    setPrivateNoStore(res);
    const session = requireShopifySession(res, "UNAUTHENTICATED");
    const command = buildCreateProductExportCommand({
      body: req.body || {},
      headers: buildHeaders(req),
      context: buildContext(req, session),
    });
    const result = await productExportUseCases.create(command);
    return res.status(200).json(toExportJobQueuedResponseDto(result));
  } catch (error) {
    return next(error);
  }
};

export const getProductExportFields = async (req, res, next) => {
  try {
    setPrivateNoStore(res);
    requireShopifySession(res, "UNAUTHENTICATED");
    const targetGranularity = String(req.query?.targetGranularity || "PRODUCT")
      .trim()
      .toUpperCase();
    return res.status(200).json({
      ok: true,
      success: true,
      fields: listExportFields({ targetGranularity }),
    });
  } catch (error) {
    return next(error);
  }
};

export const handleDownloadExportProductsData = async (req, res, next) => {
  let session = null;
  try {
    setPrivateNoStore(res);
    session = requireShopifySession(res, "UNAUTHENTICATED");
    const command = buildDownloadProductExportCommand({
      params: req.params || {},
      context: buildContext(req, session),
    });
    await streamExportCsvDownload({
      exportJobId: command.exportJobId,
      shop: command.shop,
      req,
      res,
    });
    return undefined;
  } catch (error) {
    if (error instanceof ExportDownloadError) {
      logExportDownloadFailure(error, {
        exportJobId: req.params?.id,
        shop: session?.shop || null,
      });
      if (error.code === "EXPORT_DOWNLOAD_ABORTED" || res.headersSent) {
        return undefined;
      }
      return sendDownloadError(res, error);
    }
    return next(error);
  }
};

export const cancelExportOperation = async (req, res, next) => {
  try {
    setPrivateNoStore(res);
    const session = requireShopifySession(res, "UNAUTHENTICATED");
    const command = buildCancelExportCommand({
      params: req.params || {},
      body: req.body || {},
      headers: buildHeaders(req),
      context: buildContext(req, session),
    });
    const result = await productExportLifecycleUseCases.cancel(command);
    return res.status(200).json(toExportCancellationResponseDto(result));
  } catch (error) {
    return next(error);
  }
};

export const pauseExportOperation = async (req, res, next) => {
  try {
    setPrivateNoStore(res);
    const session = requireShopifySession(res, "UNAUTHENTICATED");
    const command = buildPauseExportCommand({
      params: req.params || {},
      headers: buildHeaders(req),
      context: buildContext(req, session),
    });
    const result = await productExportLifecycleUseCases.pause(command);
    return res.status(200).json(toExportPauseResponseDto(result));
  } catch (error) {
    return next(error);
  }
};

export const resumePausedExportOperation = async (req, res, next) => {
  try {
    setPrivateNoStore(res);
    const session = requireShopifySession(res, "UNAUTHENTICATED");
    const command = buildResumeExportCommand({
      params: req.params || {},
      headers: buildHeaders(req),
      context: buildContext(req, session),
    });
    const result = await productExportLifecycleUseCases.resume(command);
    return res.status(200).json(toExportResumeResponseDto(result));
  } catch (error) {
    return next(error);
  }
};
