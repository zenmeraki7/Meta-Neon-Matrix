import { jsonResponse } from "../lib/serialise.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import {
  createBulkEditSession,
  discardSessionPendingChanges,
  getSessionById,
  getSessionColumnErrors,
  getSessionColumnVariantErrors,
  getSessionPreviewById,
} from "../useCases/sessionQueryUseCases.js";

async function handleSessionControllerError({ req, res, error, source, fallbackCode = "INTERNAL_ERROR" }) {
  await logApiError({
    shop: res.locals?.shopify?.session?.shop,
    err: error,
    req,
    source,
  });

  const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);
  return jsonResponse(res, body, statusCode);
}

function respondSessionNotFound(res) {
  const { statusCode, body } = buildPublicApiErrorResponse(
    { code: "NOT_FOUND" },
    "NOT_FOUND",
  );
  return jsonResponse(res, body, statusCode);
}

export async function createSessionController(req, res) {
  try {
    const shop = res.locals.shopify.session.shop;
    const session = await createBulkEditSession({
      shop,
      filterParams: req.body?.filterParams,
      variantCount: req.body?.variantCount,
    });
    jsonResponse(res, { session }, 201);
  } catch (error) {
    return handleSessionControllerError({
      req,
      res,
      error,
      source: "sessionController.createSessionController",
      fallbackCode: "VALIDATION_FAILED",
    });
  }
}

export async function getSessionController(req, res) {
  try {
    const shop = res.locals.shopify.session.shop;
    const session = await getSessionById({
      shop,
      sessionId: req.params.id,
    });
    if (!session) {
      return respondSessionNotFound(res);
    }
    jsonResponse(res, { session });
  } catch (error) {
    return handleSessionControllerError({
      req,
      res,
      error,
      source: "sessionController.getSessionController",
    });
  }
}

export async function getSessionPreviewController(req, res) {
  try {
    const shop = res.locals.shopify.session.shop;
    const preview = await getSessionPreviewById({
      shop,
      sessionId: req.params.id,
    });
    if (!preview) {
      return respondSessionNotFound(res);
    }
    jsonResponse(res, preview);
  } catch (error) {
    return handleSessionControllerError({
      req,
      res,
      error,
      source: "sessionController.getSessionPreviewController",
    });
  }
}

export async function getSessionColumnErrorsController(req, res) {
  try {
    const shop = res.locals.shopify.session.shop;
    const columns = await getSessionColumnErrors({
      shop,
      sessionId: req.params.id,
    });
    if (!columns) {
      return respondSessionNotFound(res);
    }
    jsonResponse(res, { columns });
  } catch (error) {
    return handleSessionControllerError({
      req,
      res,
      error,
      source: "sessionController.getSessionColumnErrorsController",
    });
  }
}

export async function getSessionColumnVariantErrorsController(req, res) {
  try {
    const shop = res.locals.shopify.session.shop;
    const result = await getSessionColumnVariantErrors({
      shop,
      sessionId: req.params.id,
      namespace: req.query?.namespace,
      key: req.query?.key,
    });
    jsonResponse(res, result);
  } catch (error) {
    return handleSessionControllerError({
      req,
      res,
      error,
      source: "sessionController.getSessionColumnVariantErrorsController",
      fallbackCode: "VALIDATION_FAILED",
    });
  }
}

export async function discardSessionController(req, res) {
  try {
    const shop = res.locals.shopify.session.shop;
    const result = await discardSessionPendingChanges({
      shop,
      sessionId: req.params.id,
    });
    jsonResponse(res, result);
  } catch (error) {
    return handleSessionControllerError({
      req,
      res,
      error,
      source: "sessionController.discardSessionController",
    });
  }
}
