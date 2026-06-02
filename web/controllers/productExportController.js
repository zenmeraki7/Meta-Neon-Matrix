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
  toExportDownloadRedirectDto,
} from "../dtos/productExportDto.js";
import {
  productExportUseCases,
  productExportLifecycleUseCases,
} from "../useCases/productExportUseCases.js";

function assertSafeDownloadUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    const error = new Error("EXPORT_FILE_URL_INVALID");
    error.code = "CONFLICT";
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const error = new Error("EXPORT_FILE_URL_INVALID");
    error.code = "CONFLICT";
    throw error;
  }
  if (parsed.protocol !== "https:") {
    const error = new Error("EXPORT_FILE_URL_UNSAFE");
    error.code = "CONFLICT";
    throw error;
  }
  return parsed.toString();
}

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

export const handleDownloadExportProductsData = async (req, res, next) => {
  try {
    setPrivateNoStore(res);
    const session = requireShopifySession(res, "UNAUTHENTICATED");
    const command = buildDownloadProductExportCommand({
      params: req.params || {},
      context: buildContext(req, session),
    });
    const result = await productExportUseCases.download(command);
    const redirect = toExportDownloadRedirectDto(result);
    return res.redirect(assertSafeDownloadUrl(redirect.downloadUrl));
  } catch (error) {
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
