import { jsonResponse } from "../lib/serialise.js";
import { getDefinitions } from "../db/metafieldDefinitions.js";

export async function getMetafieldDefinitionsController(req, res) {
  try {
    const shopDomain = String(
      res.locals?.shopify?.session?.shop ||
      res.locals?.shop ||
      "",
    ).trim();
    if (!shopDomain) {
      jsonResponse(res, { error: "Unauthenticated session" }, 401);
      return;
    }

    const definitions = await getDefinitions(shopDomain);
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
