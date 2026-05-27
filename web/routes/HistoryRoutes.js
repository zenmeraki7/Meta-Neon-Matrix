// routes/HistoryRoutes.js
import express from "express";
// import { restrictSubscribeUserWork } from "../middleware/subscriptionMiddleware.js";
import {
  getAllEditHistories,
  getHistoryChanges,
  getHistoryDetails,
  getHistorySummary,
} from "../controllers/historyController.js";

import rateLimit from "express-rate-limit";

import { validateQuery } from "../middleware/validateQuery.js";

import editHistoryQuerySchema from "../validations/editHistoryQuerySchema.js";

import {
  getAllExportHistories,
  getExportHistoryDetails,
  getExportHistoryListSummary,
  getExportHistoryDetail,
} from "../controllers/historyController.js";

import { validateSession } from "../middleware/validateSession.js";

import {
  getAllImportHistories,
  getImportHistoryDetails,
} from "../controllers/historyController.js";

const router = express.Router();
const historyRateLimiter = rateLimit({
  windowMs: +process.env.HISTORY_RATE_LIMIT_WINDOW_MS || 60_000,
  max: +process.env.HISTORY_RATE_LIMIT_MAX || 60,
  handler: (_, res) => res.status(429).json({ error: "Too Many Requests" }),
});
const importHistoryRateLimiter = rateLimit({
  windowMs: +process.env.HISTORY_RATE_LIMIT_WINDOW_MS || 60_000, // 1 min
  max: +process.env.HISTORY_RATE_LIMIT_MAX || 60,
  handler: (_, res) => res.status(429).json({ error: "Too Many Requests" }),
});
router.get(
  "/get-shop-edithistory",
  validateSession,
  historyRateLimiter,
  // restrictSubscribeUserWork,
  validateQuery(editHistoryQuerySchema),
  getAllEditHistories
);
router.get(
  "/get-shop-exporthistory",
  validateSession,
  historyRateLimiter,
  // restrictSubscribeUserWork,
  getAllExportHistories
);
router.get(
  "/export/list-summary",
  validateSession,
  historyRateLimiter,
  getExportHistoryListSummary,
);
router.get(
  "/get-edit-history-details/:id",
  validateSession,
  // restrictSubscribeUserWork,
  getHistoryDetails
);
router.get(
  "/get-edit-history-summary/:id",
  validateSession,
  getHistorySummary,
);
router.get(
  "/edit/detail/:id/summary",
  validateSession,
  getHistorySummary,
);
router.get(
  "/get-edit-history/changes/:id",
  validateSession,
  // restrictSubscribeUserWork,
  getHistoryChanges
);


router.get(
  "/get-export-details/:id",
  getExportHistoryDetails
);
router.get(
  "/export/detail/:id",
  validateSession,
  getExportHistoryDetail,
);



// GET all import histories
router.get(
  "/get-shop-importhistory",
  validateSession,
  importHistoryRateLimiter,
  getAllImportHistories
);

// GET single import history details
router.get(
  "/get-import-history-details/:id",
  validateSession,
  getImportHistoryDetails
);
export default router;
