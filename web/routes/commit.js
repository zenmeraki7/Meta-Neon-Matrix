import express from "express";
import { createJob } from "../../db/syncJobs.js";
import { jsonResponse } from "../lib/serialise.js";
import { getScoped, markSessionCommitting } from "../db/bulkEditSessions.js";
import { countRowsByStatus } from "../db/bulkEditChanges.js";

const router = express.Router();

/**
 * POST /api/sessions/:id/commit
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function commitSessionHandler(req, res) {
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
    if (String(session.status) !== "OPEN") {
      jsonResponse(res, { error: "Session is not open", code: "SESSION_NOT_OPEN" }, 409);
      return;
    }

    const pendingCount = await countRowsByStatus(sessionId, shopId, "PENDING");
    if (pendingCount === 0) {
      jsonResponse(res, { error: "No pending changes to commit" }, 422);
      return;
    }

    await markSessionCommitting({
      sessionId,
      shop: shopId,
      changeCount: pendingCount,
    });
    const job = await createJob({
      shopId,
      type: "BULK_WRITE",
      meta: { sessionId },
    });

    jsonResponse(res, {
      jobId: job.id,
      sessionId,
      changeCount: pendingCount,
    });
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to commit session" }, 500);
  }
}

router.post("/:id/commit", commitSessionHandler);

export default router;
