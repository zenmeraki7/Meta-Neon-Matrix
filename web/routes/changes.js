import express from "express";
import { jsonResponse } from "../lib/serialise.js";
import { columnApplyFanout, stageChanges } from "../db/bulkEditChanges.js";
import { getScoped } from "../db/bulkEditSessions.js";
import { getDefinition } from "../db/metafieldDefinitions.js";
import { getCurrentValue } from "../db/variantMetafields.js";

const router = express.Router();
const NUMERIC_STRING = /^\d+$/;

/**
 * POST /api/sessions/:id/changes
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function stageChangesHandler(req, res) {
  try {
    const shopId = String(res.locals.shop || "").trim();
    const sessionId = String(req.params.id || "").trim();
    if (!shopId || !sessionId) {
      jsonResponse(res, { error: "Session not found" }, 404);
      return;
    }

    const changes = Array.isArray(req.body?.changes)
      ? req.body.changes
      : Array.isArray(req.body?.cells)
        ? req.body.cells
        : null;
    if (!changes || changes.length === 0 || changes.length > 1000) {
      jsonResponse(res, { error: "Validation failed", fields: [{ field: "changes", error: "must be a non-empty array with max 1000 items" }] }, 400);
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

    const stagedPayload = [];
    for (const item of changes) {
      const variantIdRaw = String(item?.variantId || "").trim();
      const namespace = String(item?.namespace || "").trim();
      const key = String(item?.key || "").trim();
      const newValue = item?.newValue ?? item?.value ?? "";
      const compareDigest = String(item?.compareDigest || "").trim();

      if (!variantIdRaw || !NUMERIC_STRING.test(variantIdRaw) || !namespace || !key || !compareDigest) {
        jsonResponse(res, { error: "Validation failed", fields: [{ field: "changes", error: "invalid change item shape" }] }, 400);
        return;
      }

      const variantId = BigInt(variantIdRaw);
      const definition = await getDefinition(shopId, namespace, key); // eslint-disable-line no-await-in-loop
      if (!definition) {
        jsonResponse(res, { error: `Unknown metafield definition: ${namespace}.${key}` }, 422);
        return;
      }

      const oldValue = await getCurrentValue(shopId, variantId, namespace, key); // eslint-disable-line no-await-in-loop
      stagedPayload.push({
        variantId,
        namespace,
        key,
        newValue,
        compareDigest,
        definitionId: definition.id,
        type: definition.type,
        shopifyOwnerId: `gid://shopify/ProductVariant/${variantId.toString()}`,
        oldValue,
      });
    }

    await stageChanges(sessionId, shopId, stagedPayload);

    jsonResponse(res, { staged: stagedPayload.length }, 201);
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to stage changes" }, 500);
  }
}

/**
 * POST /api/sessions/:id/changes/column-apply
 * body: { namespace, key, value, variantIds[] }
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function columnApplyHandler(req, res) {
  try {
    const shopId = String(res.locals.shop || "").trim();
    const sessionId = String(req.params.id || "").trim();
    if (!shopId || !sessionId) {
      jsonResponse(res, { error: "Session not found" }, 404);
      return;
    }

    const namespace = String(req.body?.namespace || "").trim();
    const key = String(req.body?.key || "").trim();
    const value = req.body?.value == null ? null : String(req.body.value);
    const variantIdsRaw = Array.isArray(req.body?.variantIds) ? req.body.variantIds : [];
    if (!namespace || !key || variantIdsRaw.length === 0) {
      jsonResponse(
        res,
        {
          error: "Validation failed",
          fields: [{ field: "namespace/key/variantIds", error: "namespace, key and non-empty variantIds are required" }],
        },
        400,
      );
      return;
    }

    const invalidVariantId = variantIdsRaw.find((id) => !NUMERIC_STRING.test(String(id || "")));
    if (invalidVariantId) {
      jsonResponse(
        res,
        {
          error: "Validation failed",
          fields: [{ field: "variantIds", error: "all variantIds must be numeric strings" }],
        },
        400,
      );
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

    const result = await columnApplyFanout(
      sessionId,
      shopId,
      namespace,
      key,
      value,
      variantIdsRaw,
    );

    jsonResponse(res, { staged: Number(result?.staged || 0) }, 201);
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to apply column changes" }, 500);
  }
}

router.post("/:id/changes", stageChangesHandler);
router.post("/:id/changes/column-apply", columnApplyHandler);

export default router;
