import {
  createRecurringEdit,
  deleteRecurringEdit,
  getRecurringEditById,
  listRecurringEdits,
  toggleRecurringEditStatus,
  updateRecurringEdit,
} from "../services/recurringEditService.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function getSessionOrThrow(res) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  return session;
}

export async function createRecurringEditController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await createRecurringEdit({
      shop: session.shop,
      body: req.body,
      subscription: req.subscription,
    });

    return res.status(201).json({
      success: true,
      data,
      message: "Recurring edit created successfully",
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "recurringEditController.create",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function listRecurringEditsController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    if (req.query?.page && String(req.query.page) !== "1") {
      return res.status(400).json({
        success: false,
        message: "Offset pagination is disabled. Use cursor pagination.",
      });
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit || "20", 10)));
    const data = await listRecurringEdits({
      shop: session.shop,
      cursor: req.query?.cursor || null,
      limit,
      search: req.query?.search || "",
      status: req.query?.status || "",
      frequency: req.query?.frequency || "",
    });

    return res.status(200).json({
      success: true,
      data: data.items,
      items: data.items,
      pageInfo: data.pageInfo,
      totalCount: data.totalCount,
      message: "Recurring edits fetched successfully",
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "recurringEditController.list",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}
export const listRecurringEditsSummaryController = listRecurringEditsController;

export async function getRecurringEditByIdController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await getRecurringEditById({
      shop: session.shop,
      recurringEditId: req.params.id,
    });

    return res.status(200).json({
      success: true,
      data,
      message: "Recurring edit fetched successfully",
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "recurringEditController.getById",
    });

    const fallbackCode = error?.message === "Recurring edit not found"
      ? "NOT_FOUND"
      : "VALIDATION_FAILED";
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      fallbackCode,
    );
    return res.status(statusCode).json(body);
  }
}
export const getRecurringEditDetailController = getRecurringEditByIdController;

export async function updateRecurringEditController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await updateRecurringEdit({
      shop: session.shop,
      recurringEditId: req.params.id,
      body: req.body,
      subscription: req.subscription,
    });

    return res.status(200).json({
      success: true,
      data,
      message: "Recurring edit updated successfully",
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "recurringEditController.update",
    });

    const fallbackCode = error?.message === "Recurring edit not found"
      ? "NOT_FOUND"
      : "VALIDATION_FAILED";
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      fallbackCode,
    );
    return res.status(statusCode).json(body);
  }
}

export async function toggleRecurringEditStatusController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await toggleRecurringEditStatus({
      shop: session.shop,
      recurringEditId: req.params.id,
      status: req.body?.status,
      subscription: req.subscription,
    });

    return res.status(200).json({
      success: true,
      data,
      message: "Recurring edit status updated successfully",
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "recurringEditController.toggleStatus",
    });

    const fallbackCode = error?.message === "Recurring edit not found"
      ? "NOT_FOUND"
      : "VALIDATION_FAILED";
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      fallbackCode,
    );
    return res.status(statusCode).json(body);
  }
}

export async function deleteRecurringEditController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await deleteRecurringEdit({
      shop: session.shop,
      recurringEditId: req.params.id,
    });

    return res.status(200).json({
      success: true,
      data,
      message: "Recurring edit deleted successfully",
    });
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "recurringEditController.delete",
    });

    const fallbackCode = error?.message === "Recurring edit not found"
      ? "NOT_FOUND"
      : "VALIDATION_FAILED";
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      fallbackCode,
    );
    return res.status(statusCode).json(body);
  }
}
