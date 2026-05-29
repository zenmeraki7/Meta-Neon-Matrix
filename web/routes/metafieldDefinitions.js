import express from "express";
import { jsonResponse } from "../lib/serialise.js";
import { getDefinitions } from "../db/metafieldDefinitions.js";

const router = express.Router();

/**
 * GET /api/metafield-definitions
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function getMetafieldDefinitionsHandler(req, res) {
  try {
    const shopId = String(res.locals.shop || "").trim();
    if (!shopId) {
      jsonResponse(res, { error: "Unauthenticated session" }, 401);
      return;
    }

    const definitions = await getDefinitions(shopId);
    jsonResponse(res, {
      definitions: definitions.map((d) => ({
        id: d.id,
        shopifyDefinitionId: d.shopify_definition_id,
        namespace: d.namespace,
        key: d.key,
        name: d.name,
        description: d.description,
        type: d.type,
        validations: d.validations || [],
        visibleToStorefront: Boolean(d.visible_to_storefront),
      })),
    });
  } catch (error) {
    jsonResponse(res, { error: error?.message || "Failed to load metafield definitions" }, 500);
  }
}

router.get("/", getMetafieldDefinitionsHandler);

export default router;
