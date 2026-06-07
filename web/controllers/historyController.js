// web/controllers/historyController.js

import { logApiError } from "../utils/errorLogUtils.js";
import { NotFoundError } from "../utils/errorUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

import { historyUseCases } from "../useCases/historyUseCases.js";

import {
  buildExportHistoryDetailCommand,
  buildExportHistoryListCommand,
  buildEditHistoryChangesCommand,
  buildEditHistoryDetailCommand,
  buildEditHistoryListCommand,
  buildEditHistorySummaryCommand,
  buildImportHistoryDetailCommand,
  buildImportHistoryListCommand,
} from "../normalizers/historyCommandNormalizer.js";

import {
  toEditHistoryChangesResponseDto,
  toEditHistoryDetailResponseDto,
  toEditHistoryListResponseDto,
  toEditHistorySummaryResponseDto,
  toExportHistoryDetailResponseDto,
  toExportHistoryListResponseDto,
  toImportHistoryDetailResponseDto,
  toImportHistoryListResponseDto,
} from "../dtos/historyDto.js";

function buildControllerError(message, code = "VALIDATION_ERROR") {
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

function buildActorFromSession(session) {
  const associatedUser = session?.onlineAccessInfo?.associated_user;

  return Object.freeze({
    type: associatedUser?.id ? "SHOPIFY_USER" : "SHOPIFY_SESSION",
    userId: associatedUser?.id ? String(associatedUser.id) : null,
    email: associatedUser?.email || null,
  });
}

function buildBaseCommandContext({ req, session }) {
  return Object.freeze({
    shop: session.shop,
    actor: buildActorFromSession(session),
    entitlement: req.entitlement || null,
    subscription: req.subscription || null,
    activePlan: req.activePlan || {},
  });
}

function setPrivateNoStore(res) {
  res.set("Cache-Control", "no-store");
}

function buildSafeRequestLogContext(req) {
  return Object.freeze({
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    requestId: req.id || req.get?.("X-Request-Id") || null,
  });
}

async function logAndSendError({ res, req, error, shop, source }) {
  await logApiError({
    shop,
    err: error,
    req: buildSafeRequestLogContext(req),
    source,
  });

  if (error instanceof NotFoundError || error?.code === "NOT_FOUND") {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "NOT_FOUND" },
      "NOT_FOUND",
    );
    return res.status(statusCode).json(body);
  }

  const fallbackCode =
    error?.code === "UNAUTHENTICATED"
      ? "UNAUTHENTICATED"
      : error?.code === "VALIDATION_ERROR"
        ? "VALIDATION_FAILED"
        : error?.code === "PRECONDITION_REQUIRED"
          ? "VALIDATION_FAILED"
          : "INTERNAL_ERROR";

  const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);
  return res.status(statusCode).json(body);
}

function buildCommand(req, res, normalizer) {
  const session = requireShopifySession(res);

  const command = normalizer({
    params: req.params || {},
    query: req.query || {},
    context: buildBaseCommandContext({ req, session }),
  });

  return Object.freeze({
    session,
    command: Object.freeze(command),
  });
}

function assertCursorPaginationOnly(query = {}) {
  if (query?.page && String(query.page) !== "1") {
    throw buildControllerError(
      "Offset pagination is disabled. Use cursor pagination.",
      "VALIDATION_ERROR",
    );
  }
}

function toImportHistoryListDto(history) {
  return toImportHistoryListResponseDto({ histories: [history] }).data[0];
}

function toImportHistoryDetailDto(history) {
  return toImportHistoryDetailResponseDto(history).data;
}

function toImportHistoryListControllerDto(result) {
  const safe = result && typeof result === "object" ? result : {};
  const historiesFromContract = Array.isArray(safe.histories) ? safe.histories : [];
  const fallbackItems = Array.isArray(safe.items) ? safe.items : [];
  const histories = historiesFromContract.length ? historiesFromContract : fallbackItems;
  const response = toImportHistoryListResponseDto(result);

  return {
    ...response,
    data: histories.map(toImportHistoryListDto),
  };
}

function toImportHistoryDetailControllerDto(result) {
  const history = result;
  return {
    ...toImportHistoryDetailResponseDto(result),
    data: toImportHistoryDetailDto(history),
  };
}

// Export histories
export const getAllExportHistories = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);
    assertCursorPaginationOnly(req.query || {});

    const built = buildCommand(req, res, buildExportHistoryListCommand);
    session = built.session;

    const result = await historyUseCases.exports.list(built.command);

    return res.status(200).json(toExportHistoryListResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getAllExportHistories",
    });
  }
};

export const getExportHistoryDetails = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(req, res, buildExportHistoryDetailCommand);
    session = built.session;

    const result = await historyUseCases.exports.detail(built.command);

    return res.status(200).json(toExportHistoryDetailResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getExportHistoryDetails",
    });
  }
};

export const getExportHistoryDetail = getExportHistoryDetails;
export const getExportHistoryListSummary = getAllExportHistories;

// Edit histories
export const getAllEditHistories = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);
    assertCursorPaginationOnly(req.query || {});

    const built = buildCommand(req, res, buildEditHistoryListCommand);
    session = built.session;

    const result = await historyUseCases.edits.list(built.command);

    return res.status(200).json(toEditHistoryListResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getAllEditHistories",
    });
  }
};

export const getHistoryDetails = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(req, res, buildEditHistoryDetailCommand);
    session = built.session;

    const result = await historyUseCases.edits.detail(built.command);

    return res.status(200).json(toEditHistoryDetailResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getHistoryDetails",
    });
  }
};

export const getHistorySummary = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(req, res, buildEditHistorySummaryCommand);
    session = built.session;

    const result = await historyUseCases.edits.summary(built.command);

    return res.status(200).json(toEditHistorySummaryResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getHistorySummary",
    });
  }
};

export const getHistoryChanges = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(req, res, buildEditHistoryChangesCommand);
    session = built.session;

    const result = await historyUseCases.edits.changes(built.command);

    return res.status(200).json(toEditHistoryChangesResponseDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getHistoryChanges",
    });
  }
};

// Import histories
export const getAllImportHistories = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);
    assertCursorPaginationOnly(req.query || {});

    const built = buildCommand(req, res, buildImportHistoryListCommand);
    session = built.session;

    const result = await historyUseCases.imports.list(built.command);

    return res.status(200).json(toImportHistoryListControllerDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getAllImportHistories",
    });
  }
};

export const getImportHistoryDetails = async (req, res) => {
  let session;

  try {
    setPrivateNoStore(res);

    const built = buildCommand(req, res, buildImportHistoryDetailCommand);
    session = built.session;

    const result = await historyUseCases.imports.detail(built.command);

    return res.status(200).json(toImportHistoryDetailControllerDto(result));
  } catch (error) {
    return logAndSendError({
      res,
      req,
      error,
      shop: session?.shop,
      source: "historyController.getImportHistoryDetails",
    });
  }
};
