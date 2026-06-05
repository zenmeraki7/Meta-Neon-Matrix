import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { getStoreAccess as getStoreAccessForShop } from "../services/storeAccessService.js";
import { toStoreAccessDto } from "../dtos/storeAccessDto.js";

export const getStoreAccess = async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const shop = session.shop;
    const { ensureStore, readShopTimezone } = res.locals.storeAccessDependencies;

    const result = await getStoreAccessForShop({
      shop,
      ensureStore,
      readShopTimezone,
    });
    return res.status(200).json(toStoreAccessDto(result));
  } catch (error) {
    await logApiError({
      shop: res.locals?.shopify?.session?.shop,
      err: error,
      req,
      source: "storeController.getStoreAccess",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};
