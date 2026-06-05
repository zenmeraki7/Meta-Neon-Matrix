import { jsonResponse } from "../lib/serialise.js";
import { requireShopifySession } from "./controllerUtils.js";
import { getMetafieldDefinitions } from "../services/metafieldDefinitionService.js";
import { toMetafieldDefinitionListDto } from "../dtos/metafieldDefinitionDto.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

export async function getMetafieldDefinitionsController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const result = await getMetafieldDefinitions({ shop: session.shop });

    return jsonResponse(res, toMetafieldDefinitionListDto(result));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "metafieldDefinitionsController.getDefinitions",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return jsonResponse(res, body, statusCode);
  }
}
