import {
  buildAuthenticatedActor,
  getIdempotencyKey,
  handleLoggedControllerError,
  requireShopifySession,
} from "./controllerUtils.js";

import {
  createRecurringEdit,
  deleteRecurringEdit,
  getRecurringEditById,
  listRecurringEdits,
  toggleRecurringEditStatus,
  updateRecurringEdit,
} from "../services/recurringEditService.js";

import {
  buildCreateRecurringEditCommand,
  buildDeleteRecurringEditCommand,
  buildGetRecurringEditCommand,
  buildListRecurringEditsCommand,
  buildToggleRecurringEditStatusCommand,
  buildUpdateRecurringEditCommand,
} from "../normalizers/recurringEditCommandNormalizer.js";

import {
  toRecurringEditCreatedDto,
  toRecurringEditDeletedDto,
  toRecurringEditDetailDto,
  toRecurringEditListDto,
  toRecurringEditStatusUpdatedDto,
  toRecurringEditUpdatedDto,
} from "../dtos/recurringEditDto.js";

function assertCursorPaginationOnly(query = {}) {
  if (query?.page && String(query.page) !== "1") {
    const error = new Error("Offset pagination is disabled. Use cursor pagination.");
    error.code = "OFFSET_PAGINATION_DISABLED";
    throw error;
  }
}

export async function createRecurringEditController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildCreateRecurringEditCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      body: req.body,
      subscription: req.subscription || null,
      idempotencyKey: getIdempotencyKey(req),
    });

    const result = await createRecurringEdit(command);

    return res.status(201).json(toRecurringEditCreatedDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "recurringEditController.create",
      fallbackCode: "RECURRING_EDIT_CREATE_FAILED",
    });
  }
}

export async function listRecurringEditsController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    assertCursorPaginationOnly(req.query || {});

    const command = buildListRecurringEditsCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      query: req.query,
    });

    const result = await listRecurringEdits(command);

    return res.status(200).json(toRecurringEditListDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "recurringEditController.list",
      fallbackCode: "RECURRING_EDIT_LIST_FAILED",
    });
  }
}

export async function getRecurringEditByIdController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildGetRecurringEditCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      params: req.params,
    });

    const result = await getRecurringEditById(command);

    return res.status(200).json(toRecurringEditDetailDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "recurringEditController.getById",
      fallbackCode: "RECURRING_EDIT_GET_FAILED",
    });
  }
}

export async function updateRecurringEditController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildUpdateRecurringEditCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      params: req.params,
      body: req.body,
      subscription: req.subscription || null,
      idempotencyKey: getIdempotencyKey(req),
    });

    const result = await updateRecurringEdit(command);

    return res.status(200).json(toRecurringEditUpdatedDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "recurringEditController.update",
      fallbackCode: "RECURRING_EDIT_UPDATE_FAILED",
    });
  }
}

export async function toggleRecurringEditStatusController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildToggleRecurringEditStatusCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      params: req.params,
      body: req.body,
      subscription: req.subscription || null,
      idempotencyKey: getIdempotencyKey(req),
    });

    const result = await toggleRecurringEditStatus(command);

    return res.status(200).json(toRecurringEditStatusUpdatedDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "recurringEditController.toggleStatus",
      fallbackCode: "RECURRING_EDIT_STATUS_UPDATE_FAILED",
    });
  }
}

export async function deleteRecurringEditController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);

    const command = buildDeleteRecurringEditCommand({
      shop: session.shop,
      actor: buildAuthenticatedActor(req, session),
      params: req.params,
      idempotencyKey: getIdempotencyKey(req),
    });

    const result = await deleteRecurringEdit(command);

    return res.status(200).json(toRecurringEditDeletedDto(result));
  } catch (error) {
    return handleLoggedControllerError({
      res,
      req,
      session,
      error,
      source: "recurringEditController.delete",
      fallbackCode: "RECURRING_EDIT_DELETE_FAILED",
    });
  }
}

/**
 * Keep these aliases only if the route contract is intentionally identical.
 * Otherwise create dedicated summary/detail handlers and DTOs.
 */
export const listRecurringEditsSummaryController = listRecurringEditsController;
export const getRecurringEditDetailController = getRecurringEditByIdController;
