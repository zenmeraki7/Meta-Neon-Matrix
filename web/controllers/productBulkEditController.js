// web/controllers/productBulkEditController.js

import {
  buildAuthenticatedActor,
  getIdempotencyKey,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";
import { setPrivateNoStore } from "../http/cacheHeaders.js";

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

// Preview
export const trackEditPreview = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildBulkEditPreviewCommand({
      body: req.body || {},
      query: req.query || {},
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productBulkEditUseCases.preview(command);

    return res.status(200).json(toBulkEditPreviewResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.trackEditPreview",
      fallbackCode: "BULK_EDIT_PREVIEW_FAILED",
    });
  }
};

export const getEditPreviewVariantDetails = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildPreviewVariantDetailsCommand({
      params: req.params || {},
      query: req.query || {},
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productBulkEditUseCases.previewVariantDetails(command);
    return res.status(200).json(toPreviewVariantDetailsResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.getEditPreviewVariantDetails",
      fallbackCode: "BULK_EDIT_PREVIEW_VARIANTS_FAILED",
    });
  }
};

// Execute
export const handleBulkEditProduct = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildBulkEditExecuteCommand({
      body: req.body || {},
      query: req.query || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productBulkEditUseCases.execute(command);

    return res.status(202).json(toBulkEditExecuteResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.handleBulkEditProduct",
      fallbackCode: "BULK_EDIT_EXECUTE_FAILED",
    });
  }
};

// Undo
export const undoEdit = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildUndoEditCommand({
      params: req.params || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productBulkUndoUseCases.undo(command);

    return res.status(202).json(toUndoEditResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.undoEdit",
      fallbackCode: "BULK_EDIT_UNDO_FAILED",
    });
  }
};

// Scheduled edit
export const createScheduledEdit = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildScheduledEditCommand({
      body: req.body || {},
      query: req.query || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productBulkEditUseCases.schedule(command);

    return res.status(202).json(toScheduledEditResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.createScheduledEdit",
      fallbackCode: "SCHEDULED_EDIT_CREATE_FAILED",
    });
  }
};

// Lifecycle operations
export const cancelEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildCancelEditCommand({
      params: req.params || {},
      body: req.body || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productOperationLifecycleUseCases.cancel(command);

    return res.status(200).json(toOperationCancellationResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.cancelEditOperation",
      fallbackCode: "BULK_EDIT_CANCEL_FAILED",
    });
  }
};

export const pauseEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildPauseEditCommand({
      params: req.params || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productOperationLifecycleUseCases.pause(command);

    return res.status(200).json(toOperationPauseResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.pauseEditOperation",
      fallbackCode: "BULK_EDIT_PAUSE_FAILED",
    });
  }
};

export const resumePausedEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildResumeEditCommand({
      params: req.params || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productOperationLifecycleUseCases.resume(command);

    return res.status(200).json(toOperationResumeResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.resumePausedEditOperation",
      fallbackCode: "BULK_EDIT_RESUME_FAILED",
    });
  }
};

export const retryFailedOnlyEditOperation = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    session = requireShopifySession(res);
    const command = buildRetryFailedOnlyCommand({
      params: req.params || {},
      idempotencyKey: getIdempotencyKey(req),
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });
    const result = await productOperationLifecycleUseCases.retryFailedOnly(command);

    return res.status(202).json(toOperationRetryResponseDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "productBulkEditController.retryFailedOnlyEditOperation",
      fallbackCode: "BULK_EDIT_RETRY_FAILED",
    });
  }
};
