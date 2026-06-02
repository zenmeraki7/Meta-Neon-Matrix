// web/controllers/productBulkEditController.js

import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

import {
  buildBulkEditPreviewCommand,
  buildBulkEditExecuteCommand,
  buildScheduledEditCommand,
  buildUndoEditCommand,
  buildCancelEditCommand,
  buildPauseEditCommand,
  buildResumeEditCommand,
  buildRetryFailedOnlyCommand,
  buildPreviewVariantDetailsCommand,
} from "../normalizers/productBulkEditCommandNormalizer.js";

import {
  toBulkEditPreviewResponseDto,
  toBulkEditExecuteResponseDto,
  toScheduledEditResponseDto,
  toUndoEditResponseDto,
  toOperationCancellationResponseDto,
  toOperationPauseResponseDto,
  toOperationResumeResponseDto,
  toOperationRetryResponseDto,
  toPreviewVariantDetailsResponseDto,
} from "../dtos/productBulkEditDto.js";

import {
  productBulkEditUseCases,
  productBulkUndoUseCases,
  productOperationLifecycleUseCases,
} from "../useCases/productBulkEditUseCases.js";

function buildControllerError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireShopifySession(res) {
  const session = res.locals?.shopify?.session;

  if (!session?.shop) {
    throw buildControllerError("Authentication required", "UNAUTHENTICATED");
  }

  return session;
}

function buildSafeRequestLogContext(req) {
  return Object.freeze({
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    requestId: req.id || req.get?.("X-Request-Id") || null,
  });
}

function buildActorFromSession(session, fallbackType = "MERCHANT_ADMIN") {
  const associatedUser = session?.onlineAccessInfo?.associated_user;

  return Object.freeze({
    type: associatedUser?.id ? "SHOPIFY_USER" : fallbackType,
    actorId: associatedUser?.id ? String(associatedUser.id) : null,
    userId: associatedUser?.id ? String(associatedUser.id) : null,
    email: associatedUser?.email || null,
  });
}

function buildBaseCommandContext({ req, session, fallbackActorType }) {
  return Object.freeze({
    shop: session.shop,
    actor: buildActorFromSession(session, fallbackActorType),
    subscription: req.subscription || null,
    entitlement: req.entitlement || null,
    activePlan: req.activePlan || {},
  });
}

function setPrivateNoStore(res) {
  res.set("Cache-Control", "no-store");
}

async function logAndSendError({ res, req, error, shop, source }) {
  await logApiError({
    shop,
    err: error,
    req: buildSafeRequestLogContext(req),
    source,
  });

  const fallbackCode =
    error?.code === "UNAUTHENTICATED"
      ? "UNAUTHENTICATED"
      : error?.code || "VALIDATION_FAILED";

  const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);
  return res.status(statusCode).json(body);
}

function buildHeaderSnapshot(req) {
  return Object.freeze({
    idempotencyKey: req.get?.("Idempotency-Key") || null,
  });
}

function buildCommand(req, res, normalizer, fallbackActorType = "MERCHANT_ADMIN") {
  const session = requireShopifySession(res);

  const command = normalizer({
    params: req.params || {},
    query: req.query || {},
    body: req.body || {},
    headers: buildHeaderSnapshot(req),
    context: buildBaseCommandContext({
      req,
      session,
      fallbackActorType,
    }),
  });

  return Object.freeze({
    session,
    command: Object.freeze(command),
  });
}

// Preview
export const trackEditPreview = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildBulkEditPreviewCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;

    const result = await productBulkEditUseCases.preview(built.command);

    return res.status(200).json(toBulkEditPreviewResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.trackEditPreview",
    });
  }
};

export const getEditPreviewVariantDetails = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildPreviewVariantDetailsCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;
    const result = await productBulkEditUseCases.previewVariantDetails(built.command);
    return res.status(200).json(toPreviewVariantDetailsResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.getEditPreviewVariantDetails",
    });
  }
};

// Execute
export const handleBulkEditProduct = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildBulkEditExecuteCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;

    const result = await productBulkEditUseCases.execute(built.command);

    return res.status(202).json(toBulkEditExecuteResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.handleBulkEditProduct",
    });
  }
};

// Undo
export const undoEdit = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildUndoEditCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;

    const result = await productBulkUndoUseCases.undo(built.command);

    return res.status(202).json(toUndoEditResponseDto(result, built.command));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.undoEdit",
    });
  }
};

// Scheduled edit
export const createScheduledEdit = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildScheduledEditCommand,
      "SCHEDULE",
    );

    session = built.session;

    const result = await productBulkEditUseCases.schedule(built.command);

    return res.status(202).json(toScheduledEditResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.createScheduledEdit",
    });
  }
};

// Lifecycle operations
export const cancelEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildCancelEditCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;

    const result = await productOperationLifecycleUseCases.cancel(built.command);

    return res.status(200).json(toOperationCancellationResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.cancelEditOperation",
    });
  }
};

export const pauseEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildPauseEditCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;

    const result = await productOperationLifecycleUseCases.pause(built.command);

    return res.status(200).json(toOperationPauseResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.pauseEditOperation",
    });
  }
};

export const resumePausedEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildResumeEditCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;

    const result = await productOperationLifecycleUseCases.resume(built.command);

    return res.status(200).json(toOperationResumeResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.resumePausedEditOperation",
    });
  }
};

export const retryFailedOnlyEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(
      req,
      res,
      buildRetryFailedOnlyCommand,
      "MERCHANT_ADMIN",
    );

    session = built.session;

    const result = await productOperationLifecycleUseCases.retryFailedOnly(
      built.command,
    );

    return res.status(202).json(toOperationRetryResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "productBulkEditController.retryFailedOnlyEditOperation",
    });
  }
};
