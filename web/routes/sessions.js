import express from "express";
import validateBody from "../middleware/validateBody.js";
import { jsonResponse } from "../lib/serialise.js";
import { createSession, getScoped } from "../db/bulkEditSessions.js";

const router = express.Router();

const createSessionValidation = validateBody({
  filterParams: { type: "object", required: true },
  variantCount: { type: "number", required: true },
});

/**
 * POST /api/sessions
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function createSessionHandler(req, res) {
  try {
    const shopId = String(res.locals.shop || "").trim();
    if (!shopId) {
      jsonResponse(res, { error: "Unauthenticated session" }, 401);
      return;
    }

    const variantCount = Number(req.body?.variantCount || 0);
    if (!(variantCount > 0)) {
      jsonResponse(res, { error: "Validation failed", fields: [{ field: "variantCount", error: "must be > 0" }] }, 400);
      return;
    }

    const session = await createSession({
      shop: shopId,
      filterParams: req.body.filterParams,
      variantCount,
    });
    jsonResponse(res, { session }, 201);
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to create session" }, 500);
  }
}

/**
 * GET /api/sessions/:id
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function getSessionHandler(req, res) {
  try {
    const shopId = String(res.locals.shop || "").trim();
    const sessionId = String(req.params.id || "").trim();
    if (!shopId || !sessionId) {
      jsonResponse(res, { error: "Session not found" }, 404);
      return;
    }

    const session = await getScoped(sessionId, shopId);
    if (!session) {
      jsonResponse(res, { error: "Session not found" }, 404);
      return;
    }
    jsonResponse(res, { session });
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to load session" }, 500);
  }
}

router.post("/", createSessionValidation, createSessionHandler);
router.get("/:id", getSessionHandler);

export default router;
