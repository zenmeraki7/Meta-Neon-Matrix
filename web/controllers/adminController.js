// web/controllers/adminController.js (or similar)

// ❌ Remove this Mongo import:
// import History from "../schema/editHistorySchema.js";

import adminService from "../services/adminService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function getVerifiedShop(res) {
  return String(res.locals?.shopify?.session?.shop || "").trim();
}

export function __setBulkEditRecoveryServiceFactory(factory) {
  adminService.setBulkEditRecoveryServiceFactory(factory);
}

// Dashboard Overview
export const getDashboard = async (req, res) => {
  try {
    const overview = await adminService.getDashboardOverview(getVerifiedShop(res));
    res.json({ success: true, data: overview });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

export const getCompletedEditHistorySummary = async (req, res) => {
  try {
    const result = await adminService.getCompletedEditHistorySummary(getVerifiedShop(res));

    res.status(200).json({
      success: true,
      count: result.count,
      data: result.data,
    });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

// Store Management
export const getStoreStats = async (req, res) => {
  try {
    const stats = await adminService.getStoreStats(getVerifiedShop(res));
    res.json({ success: true, data: stats });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

export const getAllStores = async (req, res) => {
  try {
    const { page, cursor, limit, status, search } = req.query;
    if (page && String(page) !== "1") {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "VALIDATION_FAILED" },
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
    const result = await adminService.getAllStores({
      shop: getVerifiedShop(res),
      cursor: cursor || null,
      limit: parseInt(limit) || 20,
      status: status || "all",
      search: search || "",
    });
    res.json({ success: true, data: result });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

export const getStoreDetails = async (req, res) => {
  try {
    const details = await adminService.getStoreDetails(getVerifiedShop(res));
    res.json({ success: true, data: details });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "NOT_FOUND");
    res.status(statusCode).json(body);
  }
};

// Edit History Management
export const getEditHistoryStats = async (req, res) => {
  try {
    const stats = await adminService.getEditHistoryStats(getVerifiedShop(res));
    res.json({ success: true, data: stats });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

export const getEditHistoryList = async (req, res) => {
  try {
    const { page, cursor, limit, status, type, sortBy, sortOrder } = req.query;
    if (page && String(page) !== "1") {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "VALIDATION_FAILED" },
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
    const result = await adminService.getEditHistoryList({
      shop: getVerifiedShop(res),
      cursor: cursor || null,
      limit: parseInt(limit) || 20,
      status: status || "all",
      type: type || "all",
      sortBy: sortBy || "editTime",
      sortOrder: sortOrder || "desc",
    });
    res.json({ success: true, data: result });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

export const getFailedEdits = async (req, res) => {
  try {
    const { page, cursor, limit } = req.query;
    if (page && String(page) !== "1") {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "VALIDATION_FAILED" },
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
    const result = await adminService.getFailedEdits({
      shop: getVerifiedShop(res),
      cursor: cursor || null,
      limit: parseInt(limit) || 20,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

// Sync History Management
export const getSyncHistoryStats = async (req, res) => {
  try {
    const stats = await adminService.getSyncHistoryStats(getVerifiedShop(res));
    res.json({ success: true, data: stats });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

export const getSyncHistoryList = async (req, res) => {
  try {
    const { page, cursor, limit, status, operationType } = req.query;
    if (page && String(page) !== "1") {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "VALIDATION_FAILED" },
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
    const result = await adminService.getSyncHistoryList({
      shop: getVerifiedShop(res),
      cursor: cursor || null,
      limit: parseInt(limit) || 20,
      status: status || "all",
      operationType: operationType || "all",
    });
    res.json({ success: true, data: result });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    res.status(statusCode).json(body);
  }
};

export const recoverStuckBulkEditOperation = async (req, res) => {
  try {
    const { id } = req.params;
    const { mode = "auto", reason } = req.body || {};
    const idempotencyKey = String(req.headers["idempotency-key"] || "").trim();
    if (!id || !String(reason || "").trim()) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "VALIDATION_FAILED" },
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
    if (!idempotencyKey) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "IDEMPOTENCY_KEY_REQUIRED" },
        "VALIDATION_FAILED",
      );
      return res.status(statusCode).json(body);
    }
    const response = await adminService.recoverStuckBulkEditOperation({
      historyId: id,
      shop: getVerifiedShop(res),
      mode,
      reason,
      idempotencyKey,
      actorId: req.headers["x-admin-id"],
      actorEmail: req.headers["x-admin-email"],
    });

    return res.status(200).json(response);
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(error, "INTERNAL_ERROR");
    return res.status(statusCode).json(body);
  }
};
