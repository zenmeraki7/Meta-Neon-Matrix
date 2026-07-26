// web/controllers/productBulkEditController.js

import {
  buildAuthenticatedActor,
  getRequiredIdempotencyKey,
  handleControllerError,
  requireShopifySession,
  setPrivateNoStore,
} from "./controllerUtils.js";

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
  productBulkEditUseCases as defaultProductBulkEditUseCases,
  productBulkUndoUseCases as defaultProductBulkUndoUseCases,
  productOperationLifecycleUseCases as defaultProductOperationLifecycleUseCases,
} from "../useCases/productBulkEditUseCases.js";

function buildContext(req, session, shop) {
  return Object.freeze({
    shop,
    actor: buildAuthenticatedActor(req, session, shop),
  });
}

function buildMutationHeaders(req) {
  return Object.freeze({
    idempotencyKey: getRequiredIdempotencyKey(req),
  });
}

function assertUseCaseGroup(value, methods, name) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${name} is required`);
  }
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      throw new TypeError(`${name}.${method} must be a function`);
    }
  }
  return value;
}

export function createProductBulkEditController({
  productBulkEditUseCases = defaultProductBulkEditUseCases,
  productBulkUndoUseCases = defaultProductBulkUndoUseCases,
  productOperationLifecycleUseCases = defaultProductOperationLifecycleUseCases,
} = {}) {
  const bulkEditUseCases = assertUseCaseGroup(
    productBulkEditUseCases,
    ["preview", "previewVariantDetails", "execute", "schedule"],
    "productBulkEditUseCases",
  );

  const bulkUndoUseCases = assertUseCaseGroup(
    productBulkUndoUseCases,
    ["undo"],
    "productBulkUndoUseCases",
  );

  const lifecycleUseCases = assertUseCaseGroup(
    productOperationLifecycleUseCases,
    ["cancel", "pause", "resume", "retryFailedOnly"],
    "productOperationLifecycleUseCases",
  );

  // Preview
  async function trackEditPreview(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildBulkEditPreviewCommand({
        body: req.body ?? {},
        query: req.query ?? {},
        context,
      });

      const result = await bulkEditUseCases.preview(command);

      return res.status(200).json(toBulkEditPreviewResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "EDIT_PREVIEW_FAILED",
        "productBulkEditController.trackEditPreview",
      );
    }
  }

  async function getEditPreviewVariantDetails(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildPreviewVariantDetailsCommand({
        params: req.params ?? {},
        query: req.query ?? {},
        context,
      });

      const result = await bulkEditUseCases.previewVariantDetails(command);

      return res.status(200).json(toPreviewVariantDetailsResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "PREVIEW_VARIANT_DETAILS_FAILED",
        "productBulkEditController.getEditPreviewVariantDetails",
      );
    }
  }

  // Execute
  async function handleBulkEditProduct(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildBulkEditExecuteCommand({
        body: req.body ?? {},
        headers: buildMutationHeaders(req),
        context,
      });

      const result = await bulkEditUseCases.execute(command);

      return res.status(202).json(toBulkEditExecuteResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "BULK_EDIT_EXECUTE_FAILED",
        "productBulkEditController.handleBulkEditProduct",
      );
    }
  }

  // Undo
  async function undoEdit(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildUndoEditCommand({
        params: req.params ?? {},
        headers: buildMutationHeaders(req),
        context,
      });

      const result = await bulkUndoUseCases.undo(command);

      return res.status(202).json(toUndoEditResponseDto(result, command));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "UNDO_EDIT_FAILED",
        "productBulkEditController.undoEdit",
      );
    }
  }

  // Scheduled edit
  async function createScheduledEdit(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildScheduledEditCommand({
        body: req.body ?? {},
        headers: buildMutationHeaders(req),
        context,
      });

      const result = await bulkEditUseCases.schedule(command);

      return res.status(202).json(toScheduledEditResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "SCHEDULED_EDIT_FAILED",
        "productBulkEditController.createScheduledEdit",
      );
    }
  }

  // Lifecycle operations (Async commands return 202 Accepted)
  async function cancelEditOperation(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildCancelEditCommand({
        params: req.params ?? {},
        body: req.body ?? {},
        headers: buildMutationHeaders(req),
        context,
      });

      const result = await lifecycleUseCases.cancel(command);

      return res.status(202).json(toOperationCancellationResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "CANCEL_EDIT_FAILED",
        "productBulkEditController.cancelEditOperation",
      );
    }
  }

  async function pauseEditOperation(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildPauseEditCommand({
        params: req.params ?? {},
        headers: buildMutationHeaders(req),
        context,
      });

      const result = await lifecycleUseCases.pause(command);

      return res.status(202).json(toOperationPauseResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "PAUSE_EDIT_FAILED",
        "productBulkEditController.pauseEditOperation",
      );
    }
  }

  async function resumePausedEditOperation(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildResumeEditCommand({
        params: req.params ?? {},
        headers: buildMutationHeaders(req),
        context,
      });

      const result = await lifecycleUseCases.resume(command);

      return res.status(202).json(toOperationResumeResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "RESUME_EDIT_FAILED",
        "productBulkEditController.resumePausedEditOperation",
      );
    }
  }

  async function retryFailedOnlyEditOperation(req, res) {
    try {
      setPrivateNoStore(res);

      const { session, shop } = requireShopifySession(res);
      const context = buildContext(req, session, shop);

      const command = buildRetryFailedOnlyCommand({
        params: req.params ?? {},
        headers: buildMutationHeaders(req),
        context,
      });

      const result = await lifecycleUseCases.retryFailedOnly(command);

      return res.status(202).json(toOperationRetryResponseDto(result));
    } catch (error) {
      return handleControllerError(
        req,
        res,
        error,
        "RETRY_FAILED_EDIT_FAILED",
        "productBulkEditController.retryFailedOnlyEditOperation",
      );
    }
  }

  return Object.freeze({
    trackEditPreview,
    getEditPreviewVariantDetails,
    handleBulkEditProduct,
    undoEdit,
    createScheduledEdit,
    cancelEditOperation,
    pauseEditOperation,
    resumePausedEditOperation,
    retryFailedOnlyEditOperation,
  });
}

const defaultController = createProductBulkEditController();

export const {
  trackEditPreview,
  getEditPreviewVariantDetails,
  handleBulkEditProduct,
  undoEdit,
  createScheduledEdit,
  cancelEditOperation,
  pauseEditOperation,
  resumePausedEditOperation,
  retryFailedOnlyEditOperation,
} = defaultController;
